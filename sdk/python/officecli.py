r"""
officecli — thin Python SDK over the officecli Rust binary's resident IPC.

Communicates via Unix domain sockets with a resident server that keeps the
document in memory. Two surfaces:

  - bootstrap (infrequent): ``create`` / ``open`` spawn ONE CLI process — a
    file that isn't open yet has no resident to talk to.
  - everything else (the hot path): ``send`` / ``batch`` are pure socket
    round-trips — no per-command process spawn.

    import officecli
    with officecli.create("report.xlsx", "--force") as doc:
        doc.send({"command": "set", "path": "/Sheet1/A1",
                  "props": {"text": "Hello"}})
        print(doc.send({"command": "get", "path": "/Sheet1/A1"}))
        doc.send({"command": "save"})

Protocol (matches resident.rs):
  - socket path: ``officecli _socket-path <file>`` (hidden CLI command)
  - directory : ``~/.local/share/officecli/resident/<hash>.sock``
  - framing   : one request line + one response line, UTF-8, '\\n' terminated
  - request   : ``{"command":"...", "params":{...}}``
  - response  : ``{"result": ..., "error": "..."}``
"""

import os
import sys
import json
import socket
import shutil
import subprocess

_IS_WIN = sys.platform.startswith("win")
_builtin_open = open  # preserved; this module defines its own open()

_INSTALL_URL = "https://raw.githubusercontent.com/RainLib/Foldly/refs/heads/main/install.sh"
_MISSING_CLI = (
    "officecli CLI not found: {bin!r} is not on PATH nor in the default install "
    "location (~/.local/bin). This SDK only forwards commands to the officecli "
    "binary, which must be installed separately. Install it:\n"
    "    python -m officecli install\n"
    "    # or: curl -fsSL " + _INSTALL_URL + " | bash\n"
    "Already installed elsewhere? pass binary=\"/path/to/officecli\"."
)

# Connect timeout in seconds for socket operations
_CONNECT_TIMEOUT = 30.0


class OfficeCliError(Exception):
    """Raised on transport/process failure."""
    def __init__(self, code, msg):
        super().__init__(f"[exit {code}] {msg}")
        self.code = code


# ---------------------------------------------------------------- binary resolution

def _install_dir_candidate(name):
    """Where the official installer drops the binary."""
    if _IS_WIN:
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            return None
        exe = name if name.lower().endswith(".exe") else name + ".exe"
        return os.path.join(base, "OfficeCLI", exe)
    return os.path.join(os.path.expanduser("~"), ".local", "bin", name)


def _resolve_binary(binary):
    """Resolve the officecli binary to invoke."""
    if os.sep in binary or (os.altsep and os.altsep in binary):
        return binary
    found = shutil.which(binary)
    if found:
        return found
    cand = _install_dir_candidate(binary)
    if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
        return cand
    return binary


def _run_cli(binary, argv):
    """Run ``binary <argv...>`` (capturing output)."""
    try:
        return subprocess.run([binary, *argv], capture_output=True, text=True)
    except FileNotFoundError:
        raise OfficeCliError(127, _MISSING_CLI.format(bin=binary)) from None


# ---------------------------------------------------------------- socket discovery

def _socket_path_for_file(binary, file_path):
    """Discover the Unix socket path for a file's resident server.

    Uses the hidden ``officecli socket-path <file>`` command so we don't
    have to replicate the Rust hash algorithm in Python.
    """
    r = _run_cli(binary, ["socket-path", file_path])
    if r.returncode != 0:
        raise OfficeCliError(r.returncode, r.stderr or r.stdout or "failed to get socket path")
    return r.stdout.strip()


# ---------------------------------------------------------------- transport

def _send_unix(sock_path, line, connect_timeout=_CONNECT_TIMEOUT):
    """Send one request line over a Unix domain socket and read one response line."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(connect_timeout)
        s.connect(sock_path)
        s.settimeout(None)  # block on the reply
        s.sendall(line)
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        return buf
    finally:
        s.close()


def _rpc(sock_path, req, connect_timeout=_CONNECT_TIMEOUT):
    """Forward one request to the resident server and return the parsed response."""
    line = (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")
    raw = _send_unix(sock_path, line, connect_timeout)
    if not raw.strip():
        raise OfficeCliError(-1,
            "resident closed the connection without a response")
    text = raw.decode("utf-8").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise OfficeCliError(-1, f"invalid JSON from resident: {e}") from None


# ---------------------------------------------------------------- response parsing

def _parse(resp):
    """Extract the useful payload from an IPC response.

    Returns the ``result`` field if present, or raises on ``error``.
    """
    if resp is None:
        return None
    if isinstance(resp, dict):
        if resp.get("error"):
            raise OfficeCliError(-1, resp["error"])
        return resp.get("result")
    return resp


# ---------------------------------------------------------------- the shell

class Document:
    """A live handle to a document served by an officecli resident process.

    Use ``officecli.open(path)`` or ``officecli.create(path)`` to obtain one;
    don't construct directly.
    """

    def __init__(self, path, binary="officecli", timeout=30.0):
        self.path = os.path.abspath(path)
        self.bin = _resolve_binary(binary)
        self.timeout = timeout
        self._sock_path = None
        self._start()

    def _ensure_sock_path(self):
        """Lazily discover the socket path."""
        if self._sock_path is None:
            self._sock_path = _socket_path_for_file(self.bin, self.path)

    def _start(self):
        """Ensure a resident server is running for this file."""
        if self.alive():
            return
        r = _run_cli(self.bin, ["open", self.path])
        if r.returncode != 0:
            raise OfficeCliError(r.returncode, r.stderr or r.stdout)
        self._sock_path = None  # reset so it's re-discovered

    def _cmd(self, command, params=None, timeout=None):
        """Send a single IPC command and return the parsed result."""
        self._ensure_sock_path()
        req = {"command": command}
        if params:
            req["params"] = params
        t = self.timeout if timeout is None else timeout
        try:
            resp = _rpc(self._sock_path, req, t)
        except OfficeCliError:
            if self.alive():
                raise
            self._start()
            resp = _rpc(self._sock_path, req, t)
        return _parse(resp)

    # -- public API ----------------------------------------------------------

    def send(self, item, timeout=None):
        """Forward ONE command in officecli's batch-item shape and return its
        parsed result.

        ``item`` is a dict like:
            {"command": "set", "path": "/Sheet1/A1", "props": {"text": "hi"}}
            {"command": "get", "path": "/Sheet1/A1"}

        Keys ``command`` (or ``op``) picks the command, ``props`` becomes the
        property map, and every other key is forwarded as a parameter.
        """
        command = item.get("command") or item.get("op")
        if not command:
            raise OfficeCliError(-1, "send(item): item needs a 'command' (or 'op') key")
        params = {k: v for k, v in item.items()
                  if k not in ("command", "op", "props")}
        props = item.get("props")
        if props:
            params["properties"] = {str(k): str(v) for k, v in props.items() if v is not None}
        return self._cmd(command, params if params else None, timeout=timeout)

    def batch(self, items, force=True, stop_on_error=False, timeout=None):
        """Forward officecli's ``batch`` command: apply a LIST of item dicts
        in ONE round-trip."""
        args = {
            "batchJson": json.dumps(items, ensure_ascii=False),
            "force": str(force).lower(),
            "stopOnError": str(stop_on_error).lower(),
        }
        return self._cmd("batch", args, timeout=timeout)

    def alive(self, timeout=1.0):
        """Return True iff a resident server is alive for this file."""
        try:
            self._ensure_sock_path()
            resp = _rpc(self._sock_path, {"command": "ping"}, timeout)
            return resp is not None and resp.get("result", {}).get("status") == "alive"
        except OfficeCliError:
            return False
        except OSError:
            return False

    def close(self):
        """Stop the resident server for this document."""
        try:
            self._ensure_sock_path()
            return _parse(_rpc(self._sock_path, {"command": "close"}, self.timeout))
        except OfficeCliError:
            if self.alive():
                raise
            return ""  # resident gone — end state is "closed"
        except OSError:
            return ""  # socket already gone

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def create(path, *args, binary="officecli", timeout=30.0):
    """Create a blank Office document and return a live ``Document`` handle.

    Extra CLI flags pass through verbatim:
        with officecli.create("report.xlsx", "--force") as doc:
            doc.send({"command": "set", "path": "/Sheet1/A1",
                      "props": {"text": "hi"}})
    """
    full = os.path.abspath(path)
    binary = _resolve_binary(binary)
    r = _run_cli(binary, ["create", full, *args])
    if r.returncode != 0:
        raise OfficeCliError(r.returncode, r.stderr or r.stdout)
    return Document(full, binary=binary, timeout=timeout)


def open(path, binary="officecli", timeout=30.0):
    """Open an EXISTING document and return a live ``Document`` handle.

    ``officecli open`` is idempotent: it reuses a resident already serving
    this file or starts one.

    Lifecycle:
      Owner  — ``with officecli.open(f) as d: ...``   (exit closes the resident)
      Borrow — ``d = officecli.open(f); d.send(...)``  (no with/close → left running)
    """
    return Document(path, binary=binary, timeout=timeout)


def install():
    """Install the officecli CLI binary via its official installer."""
    if _IS_WIN:
        raise OfficeCliError(1,
            "Automatic install isn't supported on Windows. "
            "Download officecli from https://github.com/RainLib/Foldly/releases "
            "and put it on PATH.")
    print(f"Installing officecli via {_INSTALL_URL} ...", file=sys.stderr)
    r = subprocess.run(["bash", "-c", f"curl -fsSL {_INSTALL_URL} | bash"])
    if r.returncode != 0:
        raise OfficeCliError(r.returncode,
            f"officecli install failed (exit {r.returncode}). Run manually:\n"
            f"    curl -fsSL {_INSTALL_URL} | bash")
    return None


__all__ = ["open", "create", "install", "Document", "OfficeCliError"]


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "install":
        install()
    else:
        print("usage: python -m officecli install", file=sys.stderr)
        sys.exit(2)

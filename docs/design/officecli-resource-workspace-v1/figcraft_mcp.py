"""Small stdio MCP client for the installed FigCraft engine. No UI emulation."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
CLI = Path.home() / ".local/share/figcraft-mcp/0.18.1/figcraft-cli-0.18.1-macos-universal/figcraft-cli"
NATIVE = ROOT / "officecli-resource-workspace.figcraft"


class FigCraft:
    def __init__(self):
        self.stderr = (ROOT / "mcp-engine.log").open("w")
        self.process = subprocess.Popen(
            [str(CLI), "mcp", "--automation-read-root", str(REPO),
             "--automation-write-root", str(ROOT)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            text=True, bufsize=1,
        )
        self.serial = 0
        self.receipts = []
        self.rpc("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "officecli-resource-design", "version": "1.0"},
        })
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.process.stdin.flush()

    def rpc(self, method, params):
        self.serial += 1
        identifier = self.serial
        message = {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError(f"FigCraft MCP ended: {self.process.poll()}")
            response = json.loads(line)
            if response.get("id") != identifier:
                continue
            if "error" in response:
                raise RuntimeError(response["error"])
            return response["result"]

    def call(self, name, args=None):
        result = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        if result.get("isError"):
            raise RuntimeError(json.dumps(result, ensure_ascii=False))
        parts = [p["text"] for p in result.get("content", []) if p.get("type") == "text"]
        parsed = []
        for part in parts:
            try:
                parsed.append(json.loads(part))
            except json.JSONDecodeError:
                parsed.append(part)
        value = parsed[0] if len(parsed) == 1 else parsed
        self.receipts.append({"tool": name, "argumentKeys": list((args or {}).keys()),
                              "command": (args or {}).get("command"),
                              "steps": len((args or {}).get("commands", [])),
                              "result": value if name != "batch" else {"count": len(value)}})
        return value

    def command(self, command, **params):
        return self.call("run_command", {"command": command, "params": params})

    def save(self):
        return self.call("save_file", {"path": str(NATIVE)})

    def close(self):
        receipt_path = ROOT / "mcp-receipts.json"
        previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else []
        receipt_path.write_text(json.dumps(previous + self.receipts, ensure_ascii=False, indent=2))
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
        self.stderr.close()

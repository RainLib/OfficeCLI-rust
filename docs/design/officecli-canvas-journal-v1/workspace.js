/* The workspace and canvas share a document so returning to a citation preserves
   the original canvas, camera, picked objects and optional Agent connection. */
function createJournalWorkspace(board) {
  "use strict";
  const root = document.getElementById("journal-workspace");
  const landing = "campus-observations",
    canvas = "spring-field-notes",
    grid = "march-phenology";
  const prefix = "officecli-field-workspace-v1/";
  const people = ["林夏", "小舟", "阿青"];
  const kinds = { document: "文档", board: "白板", sheet: "表格" };
  const seed = [
    {
      id: landing,
      name: "校园观察记录",
      kind: "document",
      owner: "林夏",
      date: "3 月 21 日",
      star: true,
      sections: [
        [
          "p1",
          "观察缘起",
          "连续一周，我们在午休时走过同一段校园小路。每个人挑一个观察点，记下比昨天多看见的一件事。",
        ],
        [
          "p2",
          "本周路线",
          "先看教学楼东侧的玉兰，再绕过池塘。回来时在花坛前停三分钟，数一数落在花上的蜜蜂。",
        ],
        ["p3", "", board.initialParagraph()],
        [
          "p4",
          "下周复查",
          "周一、周三和周五在相同时段再走一次。把温度、开放的花朵数和蜜蜂停留次数记入三月物候表。",
        ],
      ],
    },
    {
      id: canvas,
      name: "春日观察手账",
      kind: "board",
      owner: "小舟",
      date: "3 月 21 日",
      star: true,
    },
    { id: grid, name: "三月物候表", kind: "sheet", owner: "阿青", date: "3 月 20 日" },
    {
      id: "next-walk",
      name: "下周复查清单",
      kind: "document",
      owner: "林夏",
      date: "3 月 19 日",
      sections: [
        ["p1", "出发前", "带上观察本和温度计，约定在教学楼东门集合。"],
        ["p2", "实地记录", "林夏拍玉兰，小舟查看柳枝，阿青在花坛统计三分钟内的蜜蜂。"],
      ],
    },
  ];
  const baseSheet = board.initialSheet();
  const firstComments = [
    {
      id: "route-note",
      file: landing,
      anchor: "p3",
      by: "小舟",
      text: "下次还是走这条路线吗？这样两周的记录就能对照了。",
      at: 0,
    },
  ];
  const initialEvents = [
    {
      id: "seed-comment",
      file: landing,
      anchor: "p3",
      by: "小舟",
      what: "在第 3 段留下了批注",
      at: 0,
      label: "3 月 21 日",
    },
    {
      id: "seed-ref",
      file: canvas,
      anchor: "doc",
      by: "林夏",
      what: "将文档第 3 段引用到白板",
      at: 0,
      label: "3 月 21 日",
    },
    {
      id: "seed-grid",
      file: grid,
      anchor: "A1:C4",
      by: "阿青",
      what: "更新了物候记录",
      at: 0,
      label: "3 月 20 日",
    },
  ];
  const icons = {
    brand: '<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    home: '<rect x="3" y="3" width="7" height="8" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="3" y="15" width="7" height="6" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    star: '<path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1.1 6.1-5.6-2.9-5.6 2.9 1.1-6.1L3 9.5l6.2-.9z"/>',
    document: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
    board: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 7h5v5H7zM13 12h4v5h-4z"/>',
    sheet:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11M3 14h18"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    enter: '<path d="M6 18 18 6M8 6h10v10"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    comment:
      '<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M7 9h10M7 12h7"/>',
    link: '<path d="m10 13 4-4m-5 7-1.5 1.5a3.5 3.5 0 0 1-5-5L7 9a3.5 3.5 0 0 1 5 0m0 6a3.5 3.5 0 0 0 5 0l3.5-3.5a3.5 3.5 0 0 0-5-5L14 8"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    edit: '<path d="m4 15 11-11 4 4L8 19l-5 2zM12 7l4 4"/>',
    tag: '<path d="M3 4v7l9 9 8-8-9-8z"/><circle cx="7.5" cy="8" r="1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    leaf: '<path d="M4 18C2 8 10 3 21 3c0 11-6 17-14 15m-3 3L17 8"/>',
    activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    pencil: '<path d="m4 16 10-11 5 4L8 20H4zm7-8 5 4"/>',
  };
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const icon = (name, size = 18) =>
    '<svg class="ws-icon" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    icons[name] +
    "</svg>";
  const aiMark = () => '<span class="ws-ai-mark" aria-hidden="true"></span>';
  const avatar = (who) =>
    '<span class="ws-avatar v' +
    Math.max(0, people.indexOf(who)) +
    '" title="' +
    esc(who) +
    '">' +
    esc(who.slice(-1)) +
    "</span>";
  const badge = (kind, size = 19) =>
    '<span class="ws-file-icon ' + kind + '">' + icon(kind, size) + "</span>";
  const tabKey = "officecli-workspace-journal-tabs";
  const uid = () =>
    crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const cache = new Map();
  function parse(json, fallback) {
    try {
      return json === null ? fallback : JSON.parse(json);
    } catch {
      return fallback;
    }
  }
  function get(key, fallback) {
    try {
      return parse(localStorage.getItem(prefix + key), fallback);
    } catch {
      return cache.has(key) ? cache.get(key) : fallback;
    }
  }
  function put(key, value) {
    cache.set(key, value);
    try {
      localStorage.setItem(prefix + key, JSON.stringify(value));
    } catch {}
  }
  function records(group) {
    const keys = new Set([...cache.keys()].filter((k) => k.startsWith(group + "/")));
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix + group + "/")) keys.add(k.slice(prefix.length));
      }
    } catch {}
    return [...keys].map((k) => get(k, null)).filter(Boolean);
  }
  function storedTab(fallback) {
    try {
      return parse(sessionStorage.getItem(tabKey), fallback);
    } catch {
      return fallback;
    }
  }
  const session = storedTab({}),
    drafts = session.drafts || {},
    locationByFile = session.locations || {},
    commentsDraft = session.comments || {};
  let tabs = Array.isArray(session.tabs) ? session.tabs : [canvas, landing, grid];
  function saveTab() {
    try {
      sessionStorage.setItem(
        tabKey,
        JSON.stringify({
          tabs,
          drafts,
          locations: locationByFile,
          comments: commentsDraft,
          member: session.member,
        }),
      );
    } catch {}
  }
  const files = () => [...seed, ...records("file").sort((a, b) => a.created - b.created)];
  const boardIds = () =>
    files()
      .filter((f) => f.kind === "board")
      .map((f) => f.id);
  const collection = (f) => (seed.some((row) => row.id === f.id) ? "春日校园观察" : "团队工作空间");
  const file = (id) => files().find((f) => f.id === id);
  const title = (id) => get("name/" + id, file(id)?.name || "");
  const starred = (f) => get("star/" + f.id, !!f.star);
  const token = (id, anchor) => id + "/" + anchor;
  const fieldKey = (id, anchor) => "text/" + token(id, anchor);
  const defaultValue = (f, a) =>
    f.kind === "sheet"
      ? baseSheet[Number(a.slice(1)) - 1]?.[a.charCodeAt(0) - 65] || ""
      : f.sections?.find((s) => s[0] === a)?.[2] || "";
  const value = (id, a) => {
    const f = file(id);
    return f ? get(fieldKey(id, a), defaultValue(f, a)) : "";
  };
  const visibleValue = (id, a) => drafts[token(id, a)]?.text ?? value(id, a);
  const shortDate = (t) =>
    new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(t));
  const events = () => [
    ...records("event").sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)),
    ...initialEvents,
  ];
  function event(id, anchor, by, what) {
    const item = { id: uid(), file: id, anchor, by, what, at: Date.now() };
    put("event/" + item.id, item);
  }
  const updated = (f) => {
    const t = events().find((e) => e.file === f.id)?.at;
    return t ? shortDate(t) : f.date;
  };
  function comments(id, anchor) {
    return [...firstComments, ...records("comment")]
      .filter((c) => c.file === id && c.anchor === anchor)
      .sort((a, b) => a.at - b.at);
  }
  const isResolved = (c) => get("resolved/" + c.id, false);
  const paragraphName = (a) => "第 " + Number(a.slice(1)) + " 段";
  const docs = (id) => file(id)?.sections || [];
  const refAnchor = (f) =>
    f.id === landing
      ? "p3"
      : f.kind === "sheet"
        ? "A1:C4"
        : locationByFile[f.id]?.anchor || f.sections?.[0]?.[0] || "";
  const linksFor = (id, owner) =>
    board.references(owner).filter((s) => accepts(s) && (!id || s.id === id));
  const refHere = (f, a) =>
    linksFor(f.id).find((s) => anchorOf(s) === a && s.board === board.activeBoard()) ||
    linksFor(f.id).find((s) => anchorOf(s) === a);
  let catalogue = "all",
    embedFile = landing,
    embedAI = false;
  const libraryTitle = () =>
    ({
      documents: "文档空间",
      boards: "白板空间",
      project: "春日校园观察",
      starred: "星标文件",
      all: "全部文件",
    })[catalogue] || "全部文件";
  const inCatalogue = (f) =>
    catalogue === "documents"
      ? f.kind !== "board"
      : catalogue === "boards"
        ? f.kind === "board"
        : catalogue === "project"
          ? seed.some((row) => row.id === f.id)
          : true;
  const boardPath = (id, card) => "/board/" + id + (card ? "/" + card : "");
  const realAnchor = (f, a) =>
    f.kind === "sheet"
      ? a === "A1:C4" || /^[ABC][1-4]$/.test(a)
      : !!f.sections?.some((s) => s[0] === a);
  const locationName = (f, a) => (f.kind === "document" ? paragraphName(a) : a);
  function descriptor(f, a) {
    return { id: f.id, kind: f.kind, title: title(f.id), anchor: locationName(f, a) };
  }
  function anchorOf(s) {
    return s?.kind === "document" ? "p" + (/^第 (\d+) 段$/.exec(s.anchor)?.[1] || "") : s?.anchor;
  }
  function accepts(s) {
    const f = file(s?.id);
    return !!f && f.kind !== "board" && f.kind === s.kind && realAnchor(f, anchorOf(s));
  }
  function sourceContent(s) {
    const a = anchorOf(s);
    return a === "A1:C4"
      ? baseSheet.map((r, i) =>
          r.map((_, j) => visibleValue(grid, String.fromCharCode(65 + j) + (i + 1))),
        )
      : visibleValue(s.id, a);
  }
  // Migrate the pre-workspace paragraph and range once. The original board file
  // still mirrors these two references for readers of its original schema.
  if (get(fieldKey(landing, "p3"), null) === null)
    put(fieldKey(landing, "p3"), board.initialParagraph());
  for (const [i, row] of baseSheet.entries())
    for (const [j, v] of row.entries()) {
      const k = fieldKey(grid, String.fromCharCode(65 + j) + (i + 1));
      if (get(k, null) === null) put(k, v);
    }
  function syncReferences() {
    const cells = baseSheet.map((r, i) =>
      r.map((_, j) => value(grid, String.fromCharCode(65 + j) + (i + 1))),
    );
    board.setReferences(value(landing, "p3"), cells);
  }
  let view = "board",
    current = null,
    anchor = "",
    librarySelection = landing,
    filter = "all",
    query = "",
    onlyStars = false;
  let globalChat = false,
    rail = "comments",
    preview = false,
    fromBoard = false,
    displayedRoute = null,
    dialogFocus = null;
  const note = (message) => {
    const n = document.getElementById("ws-notice");
    n.textContent = message;
    n.hidden = false;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => {
      n.hidden = true;
    }, 2200);
  };
  const action = (cmd, label, extra = "", cls = "ws-plain") =>
    '<button type="button" class="' +
    cls +
    '" data-ws="' +
    cmd +
    '" ' +
    extra +
    ">" +
    label +
    "</button>";
  const gotoFile = (id, a = "", panel = "") => {
    const f = file(id);
    if (!f) return;
    navigate(
      f.kind === "board"
        ? boardPath(id, a)
        : "/" + f.kind + "/" + id + (a ? "/" + a : "") + (panel ? "?side=" + panel : ""),
    );
  };
  function navigate(path) {
    if (path === "/board" && view === "board") return;
    if (location.hash === "#" + path) {
      if (view === "library" || view === "integrations") draw();
      else readRoute();
    } else {
      location.hash = path;
      readRoute();
    }
  }
  function currentSource() {
    if (current) return descriptor(current, anchor);
    if (view === "library" && root.querySelector("#ws-detail [data-ws=open]")) {
      const f = file(librarySelection);
      if (f && f.kind !== "board")
        return descriptor(f, locationByFile[f.id]?.anchor || refAnchor(f));
    }
    return null;
  }
  function selectedLibraryBoard() {
    if (view !== "library" || !root.querySelector("#ws-detail [data-ws=open]")) return null;
    const selected = file(librarySelection);
    return selected?.kind === "board" ? selected.id : null;
  }
  function projectContext() {
    if (view !== "home" && view !== "library" && view !== "integrations") return null;
    if (selectedLibraryBoard()) return null;
    const inProject = view === "library" && catalogue === "project";
    return {
      id: inProject ? "spring-campus" : "team-workspace",
      title: inProject ? "春日校园观察" : "团队工作空间",
      files: (inProject ? seed : files()).map((f) => ({
        id: f.id,
        title: title(f.id),
        kind: f.kind,
      })),
    };
  }
  const includeTab = (id) => {
    if (!tabs.includes(id)) tabs.push(id);
    saveTab();
  };
  function readRoute() {
    const hash = location.hash.slice(1),
      [path, queryPart = ""] = hash.split("?");
    if (displayedRoute === hash) return;
    const firstRoute = displayedRoute === null;
    const oldView = view,
      oldFile = current;
    rememberPosition();
    commitAll();
    let [area, id, a] = path.replace(/^\//, "").split("/");
    if (!["home", "library", "document", "sheet", "board", "integrations"].includes(area))
      area = "board";
    if (area === "board" && id?.startsWith("board-") && file(id)?.kind !== "board") {
      area = "library";
      id = "boards";
      a = "";
    }
    current = area === "document" || area === "sheet" ? file(id) : null;
    if ((area === "document" || area === "sheet") && (!current || current.kind !== area)) {
      current = null;
      area = "library";
    }
    view = area;
    if (area !== oldView) globalChat = false;
    displayedRoute = hash;
    if (!firstRoute && oldView === "board" && (area === "document" || area === "sheet"))
      fromBoard = true;
    else if (
      area === "library" ||
      area === "home" ||
      ((area === "document" || area === "sheet") && oldFile?.id !== current?.id)
    )
      fromBoard = false;
    if (area === "document" || area === "sheet") {
      const saved = locationByFile[current.id] || {};
      anchor = realAnchor(current, a)
        ? a
        : realAnchor(current, saved.anchor)
          ? saved.anchor
          : current.sections?.[0]?.[0] || "A1:C4";
      const side = new URLSearchParams(queryPart).get("side");
      rail =
        side === "ai" && board.chatEnabled()
          ? "ai"
          : side === "comments"
            ? "comments"
            : saved.rail === "ai" && board.chatEnabled()
              ? "ai"
              : "comments";
      includeTab(current.id);
    } else anchor = "";
    if (area === "library") {
      catalogue = ["documents", "boards", "project", "starred"].includes(id) ? id : "all";
      onlyStars = catalogue === "starred";
      if (id && file(id)) librarySelection = id;
    }
    if (area === "board") {
      root.hidden = true;
      document.body.dataset.wsView = "board";
      if (oldView !== "board") board.leaveWorkspaceChat();
      const owner = file(id)?.kind === "board" ? id : canvas;
      includeTab(owner);
      document.title = title(owner) + " · OfficeCLI 白板";
      const viewPosition = hash.startsWith("view=")
        ? hash.slice(5)
        : new URLSearchParams(queryPart).get("view");
      board.showBoard(owner === id ? a || "" : id || "", owner, viewPosition);
    } else {
      document.body.dataset.wsView = area;
      root.hidden = false;
      if (oldView === "board") board.parkBoard();
      document.title =
        (current
          ? title(current.id)
          : area === "home"
            ? "工作空间"
            : area === "integrations"
              ? "应用接入"
              : libraryTitle()) + " · OfficeCLI";
      draw();
      if (area === "document" || area === "sheet") {
        const scroller = root.querySelector(".ws-paper-scroll");
        const saved = locationByFile[current.id];
        if (saved && (!a || (firstRoute && saved.anchor === a))) {
          if (scroller) scroller.scrollTop = saved.scroll || 0;
          if (saved.caret?.field === anchor)
            restoreCaret(root.querySelector('[data-field="' + anchor + '"]'), saved.caret);
        } else if (a) scrollAnchor(false);
      } else root.querySelector(".ws-scroll")?.scrollTo(0, 0);
    }
    if (current)
      for (const [k, d] of Object.entries(drafts)) {
        if (k.startsWith(current.id + "/") && value(...k.split("/")) !== d.base) conflict(k);
      }
  }
  function rememberPosition() {
    if (current && (view === "document" || view === "sheet")) {
      locationByFile[current.id] = {
        ...locationByFile[current.id],
        anchor,
        scroll: root.querySelector(".ws-paper-scroll")?.scrollTop || 0,
        rail,
      };
      saveTab();
    }
  }
  function renderMarks() {
    root.querySelectorAll(".ws-ai-mark:empty").forEach((e) => {
      const m = board.cloneMark();
      m.setAttribute("width", "22");
      m.setAttribute("height", "22");
      e.append(m);
    });
  }
  const memberStack = () =>
    action(
      "people",
      people.map(avatar).join(""),
      'aria-label="查看空间成员" title="空间成员"',
      "ws-members",
    );
  function sidebar() {
    const nav = (cmd, label, i, active) =>
      action(
        cmd,
        icon(i) + esc(label),
        'aria-current="' + (active ? "page" : "false") + '"',
        "ws-nav" + (active ? " picked" : ""),
      );
    return (
      '<aside class="ws-side"><div class="ws-brand"><span>' +
      icon("brand", 24) +
      '</span><b>OfficeCLI</b></div><div class="ws-team"><span class="ws-team-symbol">' +
      icon("folder", 20) +
      '</span><div><strong>团队工作空间</strong><small>自然观察社</small></div></div><nav aria-label="工作空间导航">' +
      nav("home", "工作空间", "home", view === "home") +
      nav("documents", "文档空间", "document", view === "library" && catalogue === "documents") +
      nav("boards", "白板空间", "board", view === "library" && catalogue === "boards") +
      nav("library", "全部文件", "folder", view === "library" && catalogue === "all") +
      nav("stars", "星标文件", "star", view === "library" && onlyStars) +
      '<div class="ws-nav-cut"></div>' +
      nav("integrations", "应用接入", "link", view === "integrations") +
      '</nav><div class="ws-side-project"><small>共享项目</small>' +
      action("project", "<i></i>春日校园观察", "", "ws-nav") +
      '</div><button type="button" data-ws="people" class="ws-profile">' +
      avatar(member) +
      "<span><strong>" +
      esc(member) +
      "</strong><small>空间成员</small></span></button></aside>"
    );
  }
  function topbar() {
    const editor = view === "document" || view === "sheet";
    return (
      '<header class="ws-top">' +
      action("mobile-menu", icon("menu"), 'aria-label="工作空间导航"', "ws-mobile-nav") +
      '<div class="ws-breadcrumb">' +
      action("home", "团队工作空间") +
      icon("chevron", 12) +
      (editor
        ? action("documents", "文档空间") +
          icon("chevron", 12) +
          "<b>" +
          esc(title(current.id)) +
          "</b>"
        : "<b>" +
          (view === "home" ? "工作空间" : view === "integrations" ? "应用接入" : libraryTitle()) +
          "</b>") +
      '</div><div class="ws-top-right">' +
      memberStack() +
      (board.chatEnabled()
        ? action("ai", aiMark() + "AI 搭子", 'aria-label="打开 AI 搭子"', "ws-ai-button")
        : "") +
      "</div></header>"
    );
  }
  function thumb(kind) {
    if (kind === "board")
      return '<div class="ws-thumb thumb-board" aria-hidden="true"><div class="thumb-board-line"></div><i></i><i></i><i></i></div>';
    if (kind === "sheet")
      return '<div class="ws-thumb thumb-sheet" aria-hidden="true"><div class="mini-sheet"><b></b><span></span><span></span><span></span><span></span></div></div>';
    return '<div class="ws-thumb thumb-doc" aria-hidden="true"><div class="mini-paper"><b></b><i></i><i></i><i></i><i></i></div><span class="mini-bookmark"></span></div>';
  }
  function activity() {
    return events()
      .slice(0, 4)
      .map((e) =>
        action(
          "event",
          avatar(e.by) +
            "<span><b>" +
            esc(e.by) +
            "</b> " +
            esc(e.what) +
            "<small>" +
            esc(title(e.file)) +
            " · " +
            esc(e.at ? shortDate(e.at) : e.label) +
            "</small></span>" +
            icon("chevron", 14),
          'data-file="' +
            esc(e.file) +
            '" data-anchor="' +
            esc(e.anchor || "") +
            '" data-comments="' +
            String(e.what.includes("批注")) +
            '"',
          "ws-event",
        ),
      )
      .join("");
  }
  function serviceArt(boardView) {
    const art = boardView
      ? '<g fill="none" stroke="#7e638e" stroke-width="2.6" stroke-linecap="round"><path d="M36 77H65Q73 77 73 70V53Q73 46 82 46H127"/><path d="M107 79v16q0 7 8 7h35"/><path d="m146 98 5 4-5 4"/></g><g transform="rotate(-8 48 61)"><rect x="18" y="42" width="49" height="42" rx="4" fill="#F7D77F" stroke="#BFA45E"/><path d="M26 54h23m-23 6h17" fill="none" stroke="#987b40" stroke-width="2.5" stroke-linecap="round"/></g><rect x="88" y="55" width="48" height="35" rx="6" fill="#D7BDE8" stroke="#AE91C0"/><path d="M97 67h25m-25 6h16" fill="none" stroke="#9979ab" stroke-width="2.5" stroke-linecap="round"/><g transform="rotate(6 149 41)"><rect x="125" y="26" width="46" height="30" rx="5" fill="#BCDAC9" stroke="#91B8A5"/><path d="M134 37h21m-21 5h12" stroke="#769983" stroke-width="2.5" stroke-linecap="round"/></g><path d="m164 79 17 7-8 2-3 8z" fill="#5C4470" stroke="#fff7fe" stroke-width="1.4"/>'
      : '<g transform="rotate(7 108 63)"><rect x="76" y="22" width="69" height="84" rx="5" fill="#C6D1E0" stroke="#8E9FB6"/></g><g transform="rotate(-8 95 63)"><rect x="58" y="13" width="72" height="88" rx="5" fill="#FFFCF5" stroke="#9EADBF" stroke-width="1.5"/><path d="M70 31h31" stroke="#50657A" stroke-width="5" stroke-linecap="round"/><path d="M70 44h45m-45 8h37m-37 8h44m-44 16h25" stroke="#A7B4BD" stroke-width="2.5" stroke-linecap="round"/><path d="M68 67h31" stroke="#E7C56A" stroke-width="5" stroke-linecap="round"/></g><g transform="rotate(34 157 70)"><path d="M151 40q4-6 8 0v45l-4 10-4-10z" fill="#E1A38A" stroke="#9F776B"/><path d="M151 83h8l-4 11z" fill="#E1C4A7"/><path d="m153 90 2 5 2-5" fill="#595465"/><path d="M151 44h8" stroke="#F6DFCA" stroke-width="3"/></g>';
    return (
      '<svg class="ws-service-art" viewBox="0 0 205 122" fill="none" aria-hidden="true">' +
      art +
      "</svg>"
    );
  }
  function serviceCard(kind) {
    const isBoard = kind === "board",
      name = isBoard ? "白板" : "文档";
    return (
      '<article class="ws-service ' +
      (isBoard ? "is-board" : "is-doc") +
      '"><div class="ws-service-copy"><h2>' +
      name +
      "空间</h2><p>" +
      (isBoard ? "自由绘制、头脑风暴与 AI 排版" : "撰写、批注与协同编辑") +
      '</p><div class="ws-service-actions">' +
      action(
        isBoard ? "new-board" : "new",
        icon("plus", 15) + "新建" + name,
        "",
        "ws-service-primary",
      ) +
      action(
        isBoard ? "boards" : "documents",
        "打开" + name + "库 " + icon("arrow", 14),
        "",
        "ws-service-link",
      ) +
      "</div></div>" +
      serviceArt(isBoard) +
      "</article>"
    );
  }
  let embedMode = "frame";
  function embedUrl() {
    const f = file(embedFile),
      u = new URL("figjam-board.html", location.href);
    u.searchParams.set("embed", "1");
    if (!embedAI) u.searchParams.set("chat", "off");
    u.hash = f.kind === "board" ? boardPath(f.id) : "/document/" + f.id;
    return u.href;
  }
  function embedCaption() {
    return embedMode === "react"
      ? "业务后端调用 POST /integration/v1/sessions 兑换短期会话。文档和白板使用同一组件，由文件格式选择编辑器。"
      : "这个 iframe 演示当前浏览器的本地文件。接入业务账号与文件权限时可使用 React 组件。";
  }
  function embedCode() {
    if (embedMode === "react")
      return 'import { EmbeddedHcdEditor } from "@officecli/hcd-reference-editor/react";\nimport "@officecli/hcd-reference-editor/style.css";\n\n<EmbeddedHcdEditor\n  documentId={session.documentId}\n  token={session.token}\n  apiUrl="/v1/documents"\n  collabUrl={collabUrl}\n  locale="zh-CN"\n/>';
    const title = esc(kinds[file(embedFile).kind] + "编辑器"),
      url = new URL(embedUrl());
    const src = url.protocol === "file:" ? "./figjam-board.html" + url.search + url.hash : url.href;
    return (
      '<iframe title="' +
      title +
      '"\n  src="' +
      esc(src) +
      '"\n  style="width:100%;height:640px;border:0"\n></iframe>'
    );
  }
  function integrations() {
    const f = file(embedFile),
      kind = f.kind;
    const choices = files().filter((f) => f.kind === kind);
    return (
      '<div class="ws-scroll"><div class="ws-page"><div class="ws-page-title"><div><h1>应用接入</h1><p>将文档或白板编辑器放进自己的产品。</p></div></div><div class="ws-integration-grid"><section class="ws-embed-config"><h2>编辑器配置</h2><div class="ws-embed-kind">' +
      ["document", "board"]
        .map((k) =>
          action(
            "embed-kind",
            icon(k, 17) + kinds[k] + "编辑器",
            'data-kind="' + k + '" aria-pressed="' + (kind === k) + '"',
            "ws-filter",
          ),
        )
        .join("") +
      '</div><label for="ws-embed-file">预览文件</label><select id="ws-embed-file">' +
      choices
        .map(
          (c) =>
            '<option value="' +
            esc(c.id) +
            '" ' +
            (c.id === embedFile ? "selected" : "") +
            ">" +
            esc(title(c.id)) +
            "</option>",
        )
        .join("") +
      '</select><label class="ws-check"><input type="checkbox" id="ws-embed-ai" ' +
      (embedAI ? "checked" : "") +
      '>显示内置 AI 聊天</label><div class="ws-code-title"><div class="ws-filters">' +
      action(
        "embed-mode",
        "预览 iframe",
        'data-mode="frame" aria-pressed="' + (embedMode === "frame") + '"',
        "ws-filter",
      ) +
      action(
        "embed-mode",
        "React 组件",
        'data-mode="react" aria-pressed="' + (embedMode === "react") + '"',
        "ws-filter",
      ) +
      '</div></div><pre id="ws-embed-code">' +
      esc(embedCode()) +
      "</pre>" +
      action("copy-embed", icon("link", 15) + "复制代码", "", "ws-button") +
      '<p class="ws-embed-caption">' +
      embedCaption() +
      '</p></section><section class="ws-embed-preview"><header><h2>嵌入预览</h2><a href="' +
      esc(embedUrl()) +
      '" target="_blank" rel="noopener">' +
      icon("enter", 15) +
      ' 独立打开</a></header><iframe title="' +
      kinds[kind] +
      '编辑器预览" src="' +
      esc(embedUrl()) +
      '"></iframe></section></div></div></div>'
    );
  }
  function home() {
    const recent = events()
      .filter((e) => e.at)
      .map((e) => e.file);
    const ids = [...new Set([...recent, canvas, landing, grid])]
      .filter((id) => file(id))
      .slice(0, 3);
    return (
      '<div class="ws-scroll"><div class="ws-page"><div class="ws-page-title"><h1>工作空间</h1>' +
      action("integrations", icon("link", 16) + "应用接入", "", "ws-button") +
      '</div><div class="ws-services">' +
      serviceCard("document") +
      serviceCard("board") +
      '</div><div class="ws-home-lower"><section><div class="ws-section-title"><h2>最近使用</h2>' +
      action("library", "全部文件 " + icon("chevron", 13), "", "ws-text-button") +
      '</div><div class="ws-cards">' +
      ids
        .map((id) => {
          const f = file(id);
          return action(
            "open",
            thumb(f.kind) +
              '<div class="ws-card-caption">' +
              badge(f.kind, 16) +
              "<span><b>" +
              esc(title(id)) +
              "</b><small>" +
              kinds[f.kind] +
              " · " +
              f.owner +
              "</small></span>" +
              icon("enter", 15) +
              "</div>",
            'data-file="' + id + '"',
            "ws-file-card",
          );
        })
        .join("") +
      '</div><section class="ws-reference-strip"><div class="ws-section-title"><h2>白板引用</h2></div>' +
      linksFor()
        .map((s) => referenceRow(file(s.id), s.anchor))
        .join("") +
      '</section></section><section class="ws-activity"><div class="ws-section-title"><h2>协作动态</h2>' +
      icon("activity", 17) +
      "</div>" +
      activity() +
      "</section></div></div></div>"
    );
  }
  function referenceRow(f, where) {
    return action(
      "reference",
      badge(f.kind, 16) +
        "<span>" +
        esc(title(f.id)) +
        "</span><small>" +
        esc(where) +
        "</small>" +
        icon("enter", 14),
      'data-file="' +
        f.id +
        '" data-anchor="' +
        esc(anchorOf({ kind: f.kind, anchor: where })) +
        '"',
      "ws-reference-row",
    );
  }
  function libraryRows() {
    const list = files().filter(
      (f) =>
        inCatalogue(f) &&
        (filter === "all" || f.kind === filter) &&
        (!onlyStars || starred(f)) &&
        title(f.id).toLowerCase().includes(query.trim().toLowerCase()),
    );
    if (list.length && !list.some((f) => f.id === librarySelection)) librarySelection = list[0].id;
    const rows = list
      .map(
        (f) =>
          '<tr data-row="' +
          f.id +
          '" class="' +
          (librarySelection === f.id ? "is-selected" : "") +
          '"><td>' +
          action(
            "select-file",
            badge(f.kind) +
              "<span><b>" +
              esc(title(f.id)) +
              "</b><small>" +
              kinds[f.kind] +
              "</small></span>",
            'data-file="' + f.id + '"',
            "ws-filename",
          ) +
          '</td><td><span class="ws-owner">' +
          avatar(f.owner) +
          esc(f.owner) +
          "</span></td><td>" +
          esc(updated(f)) +
          "</td><td>" +
          action(
            "star",
            icon("star", 16),
            'data-file="' +
              f.id +
              '" aria-pressed="' +
              starred(f) +
              '" aria-label="' +
              (starred(f) ? "取消星标" : "加星标") +
              " " +
              esc(title(f.id)) +
              '"',
            "ws-star",
          ) +
          "</td></tr>",
      )
      .join("");
    return {
      list,
      table:
        '<table aria-label="项目文件"><thead><tr><th>名称</th><th>负责人</th><th>最近更新</th><th><span class="ws-sr">星标</span></th></tr></thead><tbody>' +
        rows +
        "</tbody></table>" +
        (list.length ? "" : '<p class="ws-empty">没有匹配的文件。</p>'),
    };
  }
  function detail(f) {
    if (!f) return '<p class="ws-empty">选择文件查看协作详情。</p>';
    const refs = f.kind === "board" ? linksFor("", f.id) : linksFor(f.id);
    const locations = refs
      .map((s) => {
        if (f.kind === "board") return referenceRow(file(s.id), s.anchor);
        const a = anchorOf(s),
          attrs =
            'data-file="' +
            f.id +
            '" data-anchor="' +
            esc(a) +
            '" data-board="' +
            esc(s.board) +
            '" data-card="' +
            esc(s.card) +
            '"';
        return (
          '<div class="ws-related-place">' +
          action(
            "backlink",
            badge("board", 14) +
              "<span>" +
              esc(title(s.board)) +
              "</span><small>" +
              esc(s.anchor) +
              "</small>" +
              icon("enter", 13),
            attrs,
            "ws-reference-row",
          ) +
          action("reference", "打开原文位置 " + icon("arrow", 12), attrs, "ws-text-button") +
          "</div>"
        );
      })
      .join("");
    return (
      '<div class="ws-section-title"><h2>文件详情</h2>' +
      icon("folder", 17) +
      "</div>" +
      thumb(f.kind) +
      "<h3>" +
      esc(title(f.id)) +
      '</h3><p class="ws-detail-type">' +
      kinds[f.kind] +
      " · " +
      esc(collection(f)) +
      "</p>" +
      action(
        "open",
        "打开" + kinds[f.kind] + " " + icon("arrow", 16),
        'data-file="' + f.id + '"',
        "ws-dark ws-wide",
      ) +
      '<dl class="ws-facts"><div><dt>负责人</dt><dd>' +
      avatar(f.owner) +
      esc(f.owner) +
      "</dd></div><div><dt>最近更新</dt><dd>" +
      esc(updated(f)) +
      "</dd></div></dl><h4>关联位置</h4>" +
      (locations || '<p class="ws-muted">还没有白板引用。</p>') +
      action("rename", icon("edit", 15) + "重命名", 'data-file="' + f.id + '"', "ws-text-button")
    );
  }
  function library() {
    const { list, table } = libraryRows();
    return (
      '<div class="ws-scroll"><div class="ws-page"><div class="ws-page-title"><div><h1>' +
      libraryTitle() +
      "</h1><p>" +
      (catalogue === "project" ? "共享项目" : "团队工作空间") +
      " · " +
      files().filter((f) => inCatalogue(f) && (!onlyStars || starred(f))).length +
      ' 个文件</p></div><div class="ws-library-actions">' +
      (catalogue !== "boards" ? action("new", icon("plus", 17) + "新建文档", "", "ws-dark") : "") +
      (catalogue !== "documents"
        ? action(
            "new-board",
            icon("plus", 17) + "新建白板",
            "",
            catalogue === "boards" ? "ws-dark" : "ws-button",
          )
        : "") +
      "</div>" +
      '</div><div class="ws-library-layout"><section class="ws-file-list"><div class="ws-library-tools"><label class="ws-search">' +
      icon("search", 17) +
      '<input type="search" id="ws-query" placeholder="搜索文件名称" aria-label="搜索文件名称" value="' +
      esc(query) +
      '"></label><div class="ws-filters" role="group" aria-label="文件类型">' +
      Object.entries(
        catalogue === "boards"
          ? { all: "全部白板" }
          : catalogue === "documents"
            ? { all: "全部文档", document: "文字", sheet: "表格" }
            : { all: "全部", document: "文档", board: "白板", sheet: "表格" },
      )
        .map(([k, v]) =>
          action(
            "filter",
            v,
            'data-filter="' + k + '" aria-pressed="' + (filter === k) + '"',
            "ws-filter",
          ),
        )
        .join("") +
      '</div></div><div class="ws-table-wrap" id="ws-rows">' +
      table +
      '</div><p class="ws-count" id="ws-count">' +
      list.length +
      ' 个文件</p></section><aside class="ws-detail" id="ws-detail">' +
      detail(list.length ? file(librarySelection) : null) +
      "</aside></div></div></div>"
    );
  }
  function refreshList() {
    const result = libraryRows();
    root.querySelector("#ws-rows").innerHTML = result.table;
    root.querySelector("#ws-count").textContent = result.list.length + " 个文件";
    root.querySelector("#ws-detail").innerHTML = detail(
      result.list.length ? file(librarySelection) : null,
    );
    root
      .querySelectorAll("[data-filter]")
      .forEach((e) => e.setAttribute("aria-pressed", String(e.dataset.filter === filter)));
    const selected = selectedLibraryBoard();
    if (selected) board.switchBoard(selected);
    if (globalChat) board.refreshChat();
  }
  let member = people.includes(session.member) ? session.member : people[0];
  function editorTabs() {
    return (
      '<nav class="ws-tabs" aria-label="打开的文件">' +
      action("library", icon("folder", 15) + "全部文件", "", "ws-tab-home") +
      tabs
        .filter((id) => file(id))
        .map((id) => {
          const f = file(id);
          return action(
            "open",
            icon(f.kind, 15) + esc(title(id)),
            'data-file="' + id + '" aria-current="' + (current.id === id ? "page" : "false") + '"',
            "ws-tab " + (current.id === id ? "selected" : ""),
          );
        })
        .join("") +
      "</nav>"
    );
  }
  function outline() {
    const f = current;
    const items =
      f.kind === "sheet"
        ? [["A1:C4", "物候记录"]]
        : docs(f.id)
            .filter((s) => s[1])
            .map((s) => [s[0], s[1]]);
    const linked = linksFor(f.id),
      pickedRef = linked.find((s) => anchorOf(s) === anchor) || linked[0];
    const rel = pickedRef
      ? action(
          "backlink",
          badge("board", 14) +
            "<span>" +
            esc(title(pickedRef.board)) +
            "</span>" +
            icon("enter", 13),
          'data-board="' +
            esc(pickedRef.board) +
            '" data-file="' +
            f.id +
            '" data-anchor="' +
            esc(anchorOf(pickedRef)) +
            '"',
          "ws-outline-link",
        )
      : '<p class="ws-muted">暂无引用</p>';
    return (
      '<aside class="ws-outline"><h3>' +
      (f.kind === "sheet" ? "工作表" : "文档大纲") +
      "</h3>" +
      items
        .map(([a, h]) =>
          action("anchor", "<i></i>" + esc(h), 'data-anchor="' + a + '"', "ws-heading-link"),
        )
        .join("") +
      '<div class="ws-outline-links"><h3>关联白板</h3>' +
      rel +
      "</div>" +
      action("documents", icon("back", 14) + "返回文档空间", "", "ws-text-button") +
      "</aside>"
    );
  }
  function docPaper() {
    const f = current,
      sections = docs(f.id);
    return (
      '<article class="ws-paper"><div class="ws-paper-meta">' +
      icon("leaf", 16) +
      esc(collection(f)) +
      "</div><h1>" +
      esc(title(f.id)) +
      '</h1><p class="ws-byline">' +
      avatar(f.owner) +
      esc(f.owner) +
      " 整理 <span>·</span> 自然观察社</p><hr>" +
      sections
        .map(([a, heading]) => {
          const refs = refHere(f, a),
            n = comments(f.id, a).filter((c) => !isResolved(c)).length;
          return (
            '<section class="ws-block" data-block="' +
            a +
            '">' +
            (heading ? "<h2>" + esc(heading) + "</h2>" : "") +
            '<div class="ws-para">' +
            '<p role="textbox" aria-multiline="true" aria-label="' +
            esc(title(f.id) + locationName(f, a)) +
            '" data-field="' +
            a +
            '" contenteditable="' +
            (preview ? "false" : "plaintext-only") +
            '" spellcheck="false">' +
            esc(visibleValue(f.id, a)) +
            "</p>" +
            (refs
              ? '<div class="ws-source-tag">' +
                icon("link", 12) +
                "白板引用 · " +
                locationName(f, a) +
                "</div>"
              : "") +
            (n
              ? action(
                  "thread",
                  icon("comment", 14) + " " + n,
                  'data-anchor="' + a + '" aria-label="查看' + locationName(f, a) + '批注"',
                  "ws-inline-comment",
                )
              : "") +
            "</div></section>"
          );
        })
        .join("") +
      "</article>"
    );
  }
  function sheetPaper() {
    return (
      '<article class="ws-paper ws-sheet-page"><div class="ws-paper-meta">' +
      icon("sheet", 16) +
      "春日校园观察</div><h1>" +
      esc(title(grid)) +
      '</h1><p class="ws-byline">' +
      avatar("阿青") +
      '阿青 整理 <span>·</span> 工作表 1</p><hr><h2>校园物候记录</h2><div class="ws-grid-wrap"><table class="ws-grid" aria-label="三月物候表 A1:C4"><thead><tr><th></th><th>A</th><th>B</th><th>C</th></tr></thead><tbody>' +
      baseSheet
        .map(
          (r, i) =>
            "<tr><th>" +
            (i + 1) +
            "</th>" +
            r
              .map((_, j) => {
                const a = String.fromCharCode(65 + j) + (i + 1);
                return (
                  '<td><input aria-label="单元格 ' +
                  a +
                  '" data-field="' +
                  a +
                  '" value="' +
                  esc(visibleValue(grid, a)) +
                  '" ' +
                  (preview ? "readonly" : "") +
                  "></td>"
                );
              })
              .join("") +
            "</tr>",
        )
        .join("") +
      '</tbody></table></div><div class="ws-source-tag">' +
      icon("link", 13) +
      "白板引用 · A1:C4</div></article>"
    );
  }
  function threadPane() {
    const items = comments(current.id, anchor);
    const location = locationName(current, anchor),
      k = token(current.id, anchor);
    return (
      '<div class="ws-rail-context">' +
      icon("link", 15) +
      "<span>" +
      esc(location) +
      '</span></div><div class="ws-comments"><div class="ws-thread-count">位置批注 <span>' +
      items.length +
      "</span></div>" +
      (items.length
        ? items
            .map((c) => {
              const done = isResolved(c),
                replies = records("reply")
                  .filter((r) => r.parent === c.id)
                  .sort((a, b) => a.at - b.at);
              return (
                '<article class="ws-comment ' +
                (done ? "resolved" : "") +
                '"><div class="ws-person">' +
                avatar(c.by) +
                "<div><b>" +
                esc(c.by) +
                "</b><small>" +
                esc(c.at ? shortDate(c.at) : "3 月 21 日") +
                "</small></div></div><p>" +
                esc(c.text) +
                "</p>" +
                replies
                  .map(
                    (r) =>
                      '<div class="ws-reply"><b>' +
                      esc(r.by) +
                      "</b><p>" +
                      esc(r.text) +
                      "</p></div>",
                  )
                  .join("") +
                '<div class="ws-comment-actions">' +
                action(
                  "reply",
                  icon("comment", 13) + "回复",
                  'data-id="' + c.id + '"',
                  "ws-text-button",
                ) +
                action(
                  "resolve",
                  icon("check", 13) + (done ? "重新打开" : "标为已解决"),
                  'data-id="' + c.id + '"',
                  "ws-text-button",
                ) +
                "</div></article>"
              );
            })
            .join("")
        : '<p class="ws-muted">可以给这个位置留下第一条批注。</p>') +
      '</div><form class="ws-comment-form" id="ws-comment-form"><label for="ws-comment-input">' +
      (commentsDraft[k]?.replyTo ? "回复批注" : "添加批注") +
      "</label>" +
      '<div><textarea id="ws-comment-input" rows="2" maxlength="2000" placeholder="写给一起观察的伙伴…">' +
      esc(commentsDraft[k]?.text || "") +
      '</textarea><button class="ws-send" type="submit" aria-label="发送批注">' +
      icon("send", 16) +
      "</button></div></form>"
    );
  }
  function railContents() {
    return (
      '<div class="ws-rail-tabs">' +
      action(
        "rail-comments",
        icon("comment", 15) + "批注",
        'aria-pressed="' + (rail === "comments") + '"',
        "ws-rail-tab",
      ) +
      (board.chatEnabled()
        ? action(
            "rail-ai",
            aiMark() + "AI 搭子",
            'aria-pressed="' + (rail === "ai") + '"',
            "ws-rail-tab",
          )
        : "") +
      action(
        "mobile-close-rail",
        icon("close", 14),
        'aria-label="收起协作栏"',
        "ws-mobile-rail-close",
      ) +
      "</div>" +
      (rail === "ai" && board.chatEnabled() ? '<div class="ws-chat-slot"></div>' : threadPane())
    );
  }
  function editorPage() {
    return (
      editorTabs() +
      '<div class="ws-editorbar"><div class="ws-mode-group">' +
      action("edit-mode", "编辑", 'aria-pressed="' + !preview + '"', "ws-mode") +
      action("read-mode", "阅读", 'aria-pressed="' + preview + '"', "ws-mode") +
      '</div><span class="ws-bar-sep"></span>' +
      action("outline", icon("folder", 15) + "大纲", "", "ws-editor-tool") +
      action(
        "put-on-board",
        icon("board", 15) + (refHere(current, anchor) ? "在白板定位" : "引用到白板"),
        'id="ws-place"',
        "ws-editor-tool",
      ) +
      (boardIds().length > 1 && refHere(current, anchor)
        ? action("choose-board", icon("plus", 13) + "引用到其他白板", "", "ws-editor-tool")
        : "") +
      action("copy-link", icon("link", 15) + "复制位置链接", "", "ws-editor-tool") +
      action("show-comments", icon("comment", 15) + "批注", "", "ws-editor-tool") +
      '<span class="ws-saved" id="ws-saved" aria-live="polite"></span>' +
      action("save", "保存", "", "ws-button") +
      (fromBoard
        ? action("return-board", icon("back", 14) + "返回白板", "", "ws-editor-tool")
        : "") +
      '</div><div class="ws-editor-body">' +
      outline() +
      '<div class="ws-paper-scroll"><div class="ws-paper-wrap">' +
      (current.kind === "sheet" ? sheetPaper() : docPaper()) +
      '</div></div><aside class="ws-rail" aria-label="文档协作">' +
      railContents() +
      "</aside></div>"
    );
  }
  function updateTarget() {
    if (!current) return;
    const activeSection =
      current.kind === "sheet"
        ? "A1:C4"
        : docs(current.id)
            .slice(0, docs(current.id).findIndex((s) => s[0] === anchor) + 1)
            .filter((s) => s[1])
            .at(-1)?.[0];
    root
      .querySelectorAll(".ws-heading-link")
      .forEach((el) => el.classList.toggle("on", el.dataset.anchor === activeSection));
    root
      .querySelectorAll("[data-block]")
      .forEach((el) => el.classList.toggle("active", el.dataset.block === anchor));
    root
      .querySelectorAll(".ws-grid input")
      .forEach((el) => el.classList.toggle("current", el.dataset.field === anchor));
    const label = root.querySelector("#ws-saved");
    if (label)
      label.textContent = Object.keys(drafts).some((k) => k.startsWith(current.id + "/"))
        ? "有未保存更改"
        : "已保存";
    const place = root.querySelector("#ws-place");
    if (place)
      place.innerHTML =
        icon("board", 15) + (refHere(current, anchor) ? "在白板定位" : "引用到白板");
    const context = root.querySelector(".ws-rail-context span");
    if (context) context.textContent = locationName(current, anchor);
  }
  function drawRail() {
    const pane = root.querySelector(".ws-rail");
    if (!pane) return;
    board.undockChat();
    pane.innerHTML = railContents();
    renderMarks();
    board.dockChat(rail === "ai" ? pane.querySelector(".ws-chat-slot") : null);
    updateTarget();
  }
  function syncRoute(keepSide) {
    const path = "/" + current.kind + "/" + current.id + "/" + anchor;
    displayedRoute = path + (keepSide ? "?side=" + rail : "");
    history.replaceState(null, "", "#" + displayedRoute);
  }
  function setAnchor(a, scroll = false) {
    if (!current || !realAnchor(current, a)) return;
    if (anchor !== a) {
      anchor = a;
      syncRoute(location.hash.includes("?side="));
      drawRail();
    }
    updateTarget();
    rememberPosition();
    if (scroll) scrollAnchor(false);
  }
  function scrollAnchor(focus) {
    const el =
      [...root.querySelectorAll("[data-field]")].find((e) => e.dataset.field === anchor) ||
      root.querySelector(".ws-grid");
    const sc = root.querySelector(".ws-paper-scroll");
    if (el && sc) {
      const b = el.getBoundingClientRect(),
        s = sc.getBoundingClientRect();
      if (b.top < s.top + 28 || b.bottom > s.bottom - 25)
        sc.scrollTop += b.top - s.top - Math.min(100, s.height * 0.18);
      if (focus) el.focus({ preventScroll: true });
    }
  }
  function draw() {
    const editor = !!current && (view === "document" || view === "sheet");
    board.undockChat();
    root.className =
      "ws " +
      (editor ? "ws-editor" : "ws-browser") +
      (editor && new URLSearchParams(location.hash.split("?")[1]).has("side")
        ? " ws-mobile-rail"
        : "");
    root.innerHTML =
      sidebar() +
      '<div class="ws-main">' +
      topbar() +
      (editor
        ? editorPage()
        : view === "home"
          ? home()
          : view === "integrations"
            ? integrations()
            : library()) +
      "</div>" +
      (!editor && globalChat && board.chatEnabled()
        ? '<aside class="ws-floating-ai" aria-label="工作空间 AI 搭子"><div class="ws-chat-slot"></div></aside>'
        : "");
    renderMarks();
    const selected = selectedLibraryBoard();
    if (selected) board.switchBoard(selected);
    board.dockChat(
      editor
        ? rail === "ai"
          ? root.querySelector(".ws-chat-slot")
          : null
        : root.querySelector(".ws-floating-ai .ws-chat-slot"),
    );
    updateTarget();
  }
  function caretOf(el) {
    if (!el || document.activeElement !== el) return null;
    const field = el.dataset.field;
    if (el instanceof HTMLInputElement)
      return { field, start: el.selectionStart, end: el.selectionEnd };
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(el);
    prefix.setEnd(r.startContainer, r.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(r.endContainer, r.endOffset);
    return { field, start, end: prefix.toString().length };
  }
  function restoreCaret(el, pos) {
    if (!el || !pos || preview) return;
    el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement) {
      el.setSelectionRange(pos.start, pos.end);
      return;
    }
    const locate = (offset) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node, last;
      while ((node = walker.nextNode())) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
        last = node;
      }
      return last ? [last, last.length] : [el, 0];
    };
    const r = document.createRange();
    r.setStart(...locate(pos.start));
    r.setEnd(...locate(pos.end));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function rememberCaret() {
    if (!current) return;
    const el = document.activeElement;
    if (!el?.dataset.field || !root.contains(el)) return;
    const caret = caretOf(el);
    if (!caret) return;
    locationByFile[current.id] = { ...locationByFile[current.id], caret };
    saveTab();
  }
  document.addEventListener("selectionchange", rememberCaret);
  root.addEventListener("select", rememberCaret, true);
  function replaceField(el, text) {
    const input = el instanceof HTMLInputElement;
    if ((input ? el.value : el.innerText) === text) return;
    const caret = caretOf(el);
    if (input) el.value = text;
    else el.textContent = text;
    if (caret) restoreCaret(el, caret);
  }
  function updateField(k) {
    if (!current) return;
    const [id, a] = k.split("/");
    if (current.id !== id || drafts[k]) return;
    const el = [...root.querySelectorAll("[data-field]")].find((n) => n.dataset.field === a);
    if (el) replaceField(el, value(id, a));
  }
  function draftField(el) {
    const a = el.dataset.field,
      k = token(current.id, a),
      v = el instanceof HTMLInputElement ? el.value : el.innerText;
    if (v === value(current.id, a)) delete drafts[k];
    else drafts[k] = { base: drafts[k]?.base ?? value(current.id, a), text: v };
    saveTab();
    updateTarget();
  }
  function conflict(k) {
    if (root.querySelector(".ws-conflict")) return;
    const bar = document.createElement("div");
    bar.className = "ws-conflict";
    bar.setAttribute("role", "alert");
    bar.innerHTML =
      "<div><b>这个位置已有新的编辑</b><p>最新正文：" +
      esc(value(...k.split("/"))) +
      "</p></div>" +
      action("use-new", "采用最新正文", 'data-key="' + esc(k) + '"', "ws-button") +
      action("keep-mine", "保存我的版本", 'data-key="' + esc(k) + '"', "ws-button");
    root.querySelector(".ws-paper-wrap")?.prepend(bar);
  }
  function commitAll(forceKey = "") {
    if (!current || (view !== "document" && view !== "sheet")) return true;
    const local = Object.entries(drafts).filter(([key]) => key.startsWith(current.id + "/"));
    for (const [k, d] of local) {
      const before = value(...k.split("/"));
      if (before !== d.base && before !== d.text && forceKey !== k) {
        conflict(k);
        return false;
      }
    }
    let changed = false;
    for (const [k, d] of local) {
      const [id, a] = k.split("/");
      const before = value(id, a);
      if (before !== d.text) {
        put(fieldKey(id, a), d.text);
        event(id, a, member, "更新了" + locationName(current, a));
        changed = true;
      }
      delete drafts[k];
    }
    saveTab();
    if (changed) syncReferences();
    updateTarget();
    return true;
  }
  function append(source, text, author, owner = canvas) {
    let s = source?.kind === "document" && accepts(source) ? source : null;
    if (!s && owner !== canvas) {
      const id = "notes-" + owner;
      if (!file(id))
        put("file/" + id, {
          id,
          name: title(owner) + " · 白板笔记",
          kind: "document",
          owner: member,
          created: Date.now(),
          date: shortDate(Date.now()),
          sections: [["p1", "白板记录", ""]],
        });
      s = descriptor(file(id), "p1");
    }
    if (!s) s = descriptor(file(landing), "p3");
    const a = anchorOf(s),
      k = token(s.id, a),
      previous = value(s.id, a),
      join = (v) => v + (v ? "\n\n" : "") + text;
    const d = drafts[k];
    put(fieldKey(s.id, a), join(previous));
    if (d) {
      if (d.base === previous) d.base = join(previous);
      d.text = join(d.text);
      saveTab();
    }
    const target =
      current?.id === s.id
        ? [...root.querySelectorAll("[data-field]")].find((el) => el.dataset.field === a)
        : null;
    if (target) replaceField(target, visibleValue(s.id, a));
    event(s.id, a, author, "向" + s.anchor + "追加了内容");
    syncReferences();
    updateTarget();
    return { id: s.id, anchor: a };
  }
  function openDialog(heading, content) {
    const modal = document.getElementById("ws-dialog");
    dialogFocus = document.activeElement;
    modal.querySelector("h2").textContent = heading;
    modal.querySelector(".ws-dialog-content").innerHTML = content;
    if (!modal.open) modal.showModal();
    modal.querySelector("input")?.focus();
  }
  function closeDialog() {
    document.getElementById("ws-dialog").close();
    dialogFocus?.focus?.({ preventScroll: true });
  }
  function changeSide(mode) {
    if (mode === "ai" && !board.chatEnabled()) return;
    rail = mode;
    syncRoute(true);
    root.classList.add("ws-mobile-rail");
    drawRail();
    rememberPosition();
  }
  function linkToLocation() {
    const u = new URL(location.href);
    u.hash = "/" + current.kind + "/" + current.id + "/" + anchor;
    u.searchParams.delete("member");
    return u.href;
  }
  async function copyLocation() {
    const link = linkToLocation();
    try {
      await navigator.clipboard.writeText(link);
      note("已复制当前位置链接");
    } catch {
      openDialog(
        "当前位置链接",
        '<label>复制后可打开同一个位置<input readonly value="' + esc(link) + '"></label>',
      );
      document.querySelector("#ws-dialog input").select();
    }
  }
  function refreshModel(key) {
    if (key.startsWith("text/")) {
      const k = key.slice(5);
      if (drafts[k] && value(...k.split("/")) !== drafts[k].base && current?.id === k.split("/")[0])
        conflict(k);
      updateField(k);
      syncReferences();
    }
    if (view === "library") refreshList();
    else if (view === "home") draw();
    else if (
      current &&
      (key.startsWith("comment/") || key.startsWith("reply/") || key.startsWith("resolved/"))
    ) {
      if (rail === "comments") drawRail();
      refreshCounts();
    }
    if (key.startsWith("name/") && current) {
      const h = root.querySelector(".ws-paper h1");
      if (h) h.textContent = title(current.id);
      const b = root.querySelector(".ws-breadcrumb b");
      if (b) b.textContent = title(current.id);
      root.querySelectorAll(".ws-tab").forEach((t) => {
        if (t.dataset.file === key.slice(5))
          t.innerHTML = icon(file(t.dataset.file).kind, 15) + esc(title(t.dataset.file));
      });
    }
    if (key.startsWith("name/")) board.refreshNames();
  }
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith(prefix)) refreshModel(e.key.slice(prefix.length));
  });
  window.addEventListener("hashchange", readRoute);
  window.addEventListener("pagehide", () => {
    rememberPosition();
    commitAll();
    saveTab();
  });
  root.addEventListener("focusin", (e) => {
    if (e.target.dataset.field) setAnchor(e.target.dataset.field);
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "ws-query") {
      query = e.target.value;
      refreshList();
    } else if (e.target.dataset.field) draftField(e.target);
    else if (e.target.id === "ws-comment-input") {
      const k = token(current.id, anchor);
      commentsDraft[k] = { ...commentsDraft[k], text: e.target.value };
      saveTab();
    }
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "ws-embed-file") {
      embedFile = e.target.value;
      draw();
    }
    if (e.target.id === "ws-embed-ai") {
      embedAI = e.target.checked;
      draw();
    }
  });
  root.addEventListener("submit", (e) => {
    if (e.target.id !== "ws-comment-form") return;
    e.preventDefault();
    const k = token(current.id, anchor),
      d = commentsDraft[k] || {},
      text = e.target.querySelector("textarea").value.trim();
    if (!text) return;
    const item = { id: uid(), file: current.id, anchor, by: member, text, at: Date.now() };
    if (d.replyTo) {
      item.parent = d.replyTo;
      put("reply/" + item.id, item);
    } else put("comment/" + item.id, item);
    event(
      current.id,
      anchor,
      member,
      d.replyTo ? "回复了批注" : "在" + locationName(current, anchor) + "留下了批注",
    );
    delete commentsDraft[k];
    saveTab();
    drawRail();
    refreshCounts();
    note(d.replyTo ? "已回复" : "已添加批注");
  });
  function refreshCounts() {
    if (!current || current.kind !== "document") return;
    root.querySelectorAll("[data-block]").forEach((s) => {
      const a = s.dataset.block,
        n = comments(current.id, a).filter((c) => !isResolved(c)).length;
      let b = s.querySelector(".ws-inline-comment");
      if (!n) {
        b?.remove();
        return;
      }
      if (!b) {
        s.querySelector(".ws-para").insertAdjacentHTML(
          "beforeend",
          action("thread", "", 'data-anchor="' + a + '"', "ws-inline-comment"),
        );
        b = s.querySelector(".ws-inline-comment");
      }
      b.innerHTML = icon("comment", 14) + " " + n;
      b.setAttribute("aria-label", "查看" + paragraphName(a) + "批注");
    });
  }
  root.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (commitAll()) note("更改已保存");
    }
    if (e.key === "Escape")
      root.classList.remove("ws-mobile-side", "ws-mobile-rail", "ws-mobile-outline");
  });
  function putReference(ref, owner) {
    const exists = board.knownReference(ref, owner);
    board.switchBoard(owner);
    const target = board.makeReference(ref, member);
    if (!exists)
      event(ref.id, anchorOf(ref), member, "将" + ref.anchor + "引用到《" + title(owner) + "》");
    gotoFile(owner, target);
  }
  function dispatch(b) {
    const cmd = b.dataset.ws,
      id = b.dataset.file,
      a = b.dataset.anchor;
    if (
      ["home", "library", "documents", "boards", "stars", "project", "integrations"].includes(cmd)
    ) {
      query = "";
      filter = "all";
      navigate(
        {
          home: "/home",
          library: "/library",
          documents: "/library/documents",
          boards: "/library/boards",
          stars: "/library/starred",
          project: "/library/project",
          integrations: "/integrations",
        }[cmd],
      );
      return;
    }
    if (cmd === "embed-kind") {
      embedFile = files().find((f) => f.kind === b.dataset.kind).id;
      draw();
      return;
    }
    if (cmd === "embed-mode") {
      embedMode = b.dataset.mode;
      root
        .querySelectorAll("[data-ws=embed-mode]")
        .forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.mode === embedMode)));
      root.querySelector("#ws-embed-code").textContent = embedCode();
      root.querySelector(".ws-embed-caption").textContent = embedCaption();
      return;
    }
    if (cmd === "copy-embed") {
      const code = embedCode();
      navigator.clipboard
        ?.writeText(code)
        .then(() => note("嵌入代码已复制"))
        .catch(() => selectCode());
      if (!navigator.clipboard) selectCode();
      function selectCode() {
        const r = document.createRange();
        r.selectNodeContents(root.querySelector("#ws-embed-code"));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        note("已选中嵌入代码，可复制");
      }
      return;
    }
    if (cmd === "open-board") return gotoFile(canvas);
    if (cmd === "open") return gotoFile(id);
    if (cmd === "event") {
      if (file(id)?.kind === "board") return gotoFile(id, a);
      return gotoFile(id, a, b.dataset.comments === "true" ? "comments" : "");
    }
    if (cmd === "reference") return gotoFile(id, a || refAnchor(file(id)));
    if (cmd === "return-board") return gotoFile(board.activeBoard());
    if (cmd === "put-on-board" || cmd === "choose-board") {
      if (!commitAll()) return;
      const ref = descriptor(current, anchor),
        existing = refHere(current, anchor);
      if (cmd === "put-on-board" && existing) return gotoFile(existing.board, existing.card);
      if (boardIds().length === 1) return putReference(ref, canvas);
      openDialog(
        "选择引用的目标白板",
        '<div class="ws-member-list">' +
          boardIds()
            .map((owner) =>
              action(
                "destination",
                badge("board", 16) + esc(title(owner)) + " " + icon("arrow", 14),
                'data-board="' + esc(owner) + '"',
                "ws-member",
              ),
            )
            .join("") +
          "</div>",
      );
      return;
    }
    if (cmd === "backlink") {
      const owner = b.dataset.board || board.activeBoard(),
        ref = descriptor(file(id), a || refAnchor(file(id)));
      return gotoFile(owner, b.dataset.card || board.knownReference(ref, owner));
    }
    if (cmd === "select-file") {
      librarySelection = id;
      refreshList();
      return;
    }
    if (cmd === "filter") {
      filter = b.dataset.filter;
      refreshList();
      return;
    }
    if (cmd === "star") {
      put("star/" + id, !starred(file(id)));
      refreshList();
      return;
    }
    if (cmd === "new" || cmd === "new-board" || cmd === "rename") {
      const fresh = cmd !== "rename",
        kind = cmd === "new-board" ? "board" : "document";
      openDialog(
        fresh ? "新建" + kinds[kind] : "重命名文件",
        '<form id="ws-name-form" data-kind="' +
          kind +
          '" data-id="' +
          esc(id || "") +
          '"><label>文件名称<input name="name" maxlength="48" required value="' +
          (fresh ? "" : esc(title(id))) +
          '" placeholder="输入文件名称"></label><button class="ws-dark" type="submit">' +
          (fresh ? "创建并打开" : "保存名称") +
          "</button></form>",
      );
      return;
    }
    if (cmd === "anchor") {
      setAnchor(a, true);
      root.classList.remove("ws-mobile-outline");
      return;
    }
    if (cmd === "outline") {
      root.classList.toggle("ws-mobile-outline");
      root.classList.toggle("ws-outline-hidden");
      return;
    }
    if (cmd === "mobile-menu") {
      root.classList.toggle("ws-mobile-side");
      return;
    }
    if (cmd === "people") {
      openDialog(
        "空间成员",
        '<p>选择在此标签页使用的演示身份。</p><div class="ws-member-list">' +
          people
            .map((p, i) =>
              action(
                "member",
                avatar(p) +
                  "<b>" +
                  p +
                  "</b><small>" +
                  (p === member ? "当前身份" : "切换") +
                  "</small>",
                'data-who="' + i + '"',
                "ws-member",
              ),
            )
            .join("") +
          "</div>",
      );
      return;
    }
    if (cmd === "ai") {
      if (current) return changeSide("ai");
      globalChat = !globalChat;
      draw();
      if (globalChat) document.getElementById("draft").focus();
      return;
    }
    if (cmd === "rail-comments" || cmd === "show-comments" || cmd === "thread") {
      if (a) setAnchor(a, true);
      return changeSide("comments");
    }
    if (cmd === "rail-ai") return changeSide("ai");
    if (cmd === "mobile-close-rail") {
      root.classList.remove("ws-mobile-rail");
      syncRoute(false);
      return;
    }
    if (cmd === "read-mode" || cmd === "edit-mode") {
      if (!commitAll()) return;
      rememberPosition();
      preview = cmd === "read-mode";
      const y = root.querySelector(".ws-paper-scroll").scrollTop;
      draw();
      root.querySelector(".ws-paper-scroll").scrollTop = y;
      return;
    }
    if (cmd === "save") {
      if (commitAll()) note("更改已保存");
      return;
    }
    if (cmd === "copy-link") return copyLocation();
    if (cmd === "reply") {
      const k = token(current.id, anchor);
      commentsDraft[k] = { ...commentsDraft[k], replyTo: b.dataset.id };
      saveTab();
      drawRail();
      root.querySelector("#ws-comment-input")?.focus();
      return;
    }
    if (cmd === "resolve") {
      const cid = b.dataset.id;
      put("resolved/" + cid, !get("resolved/" + cid, false));
      event(
        current.id,
        anchor,
        member,
        get("resolved/" + cid, false) ? "解决了一条批注" : "重新打开了批注",
      );
      drawRail();
      refreshCounts();
      return;
    }
    if (cmd === "use-new") {
      const k = b.dataset.key;
      delete drafts[k];
      saveTab();
      updateField(k);
      b.closest(".ws-conflict").remove();
      updateTarget();
      return;
    }
    if (cmd === "keep-mine") {
      if (commitAll(b.dataset.key)) b.closest(".ws-conflict").remove();
      return;
    }
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ws]");
    if (b) {
      dispatch(b);
      return;
    }
    const row = e.target.closest("[data-row]");
    if (row) {
      librarySelection = row.dataset.row;
      refreshList();
    }
  });
  root.addEventListener("dblclick", (e) => {
    const b = e.target.closest('[data-ws="select-file"]');
    if (b) gotoFile(b.dataset.file);
  });
  const dialog = document.getElementById("ws-dialog");
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-dialog]")) closeDialog();
    const choice = e.target.closest('[data-ws="destination"]');
    if (choice && current) {
      const ref = descriptor(current, anchor);
      closeDialog();
      putReference(ref, choice.dataset.board);
      return;
    }
    const b = e.target.closest('[data-ws="member"]');
    if (b) {
      member = people[Number(b.dataset.who)];
      session.member = member;
      saveTab();
      closeDialog();
      rememberPosition();
      draw();
      scrollAnchor(false);
      note("当前演示身份 · " + member);
    }
  });
  dialog.addEventListener("submit", (e) => {
    if (e.target.id !== "ws-name-form") return;
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    if (!name) return;
    let id = e.target.dataset.id;
    if (id) {
      put("name/" + id, name);
      event(id, refAnchor(file(id)), member, "重命名了文件");
      board.refreshNames();
      closeDialog();
      draw();
    } else {
      const kind = e.target.dataset.kind === "board" ? "board" : "document";
      id = (kind === "board" ? "board-" : "doc-") + uid();
      put("file/" + id, {
        id,
        name,
        kind,
        owner: member,
        created: Date.now(),
        date: shortDate(Date.now()),
        ...(kind === "document" ? { sections: [["p1", "正文", ""]] } : {}),
      });
      event(id, kind === "document" ? "p1" : "", member, "创建了" + kinds[kind]);
      closeDialog();
      gotoFile(id, kind === "document" ? "p1" : "");
    }
  });
  return {
    start() {
      syncReferences();
      board.refreshNames();
      readRoute();
    },
    title,
    boardIds,
    member: () => member,
    accepts,
    sourceContent,
    currentSource,
    projectContext,
    append,
    references: (owner) => linksFor("", owner).map((s) => ({ ...s, title: title(s.id) })),
    openSource(type) {
      gotoFile(type === "doc" ? landing : grid, type === "doc" ? "p3" : "A1:C4");
    },
    openDocument(id, a) {
      gotoFile(id, a, "comments");
    },
    openResource(ref) {
      if (accepts(ref)) gotoFile(ref.id, anchorOf(ref));
    },
    home() {
      navigate("/home");
    },
    library(area = "") {
      navigate(area ? "/library/" + area : "/library");
    },
    openBoard() {
      gotoFile(board.activeBoard());
    },
    isInWorkspace: () => view !== "board",
    closeChat() {
      if (current) changeSide("comments");
      else {
        globalChat = false;
        draw();
        root.querySelector(".ws-ai-button")?.focus();
      }
    },
    referencesChanged() {
      if (view === "library") refreshList();
      else if (view === "home") draw();
      else if (current) {
        root.querySelector(".ws-outline")?.remove();
        root.querySelector(".ws-editor-body")?.insertAdjacentHTML("afterbegin", outline());
        for (const section of root.querySelectorAll("[data-block]")) {
          const a = section.dataset.block,
            linked = board.knownReference(descriptor(current, a));
          const mark = section.querySelector(".ws-source-tag");
          if (mark && !linked) mark.remove();
          if (!mark && linked)
            section
              .querySelector(".ws-para p")
              .insertAdjacentHTML(
                "afterend",
                '<div class="ws-source-tag">' +
                  icon("link", 12) +
                  "白板引用 · " +
                  locationName(current, a) +
                  "</div>",
              );
        }
        updateTarget();
      }
    },
    availabilityChanged() {
      if (!board.chatEnabled() && rail === "ai") rail = "comments";
      if (view !== "board") draw();
    },
  };
}

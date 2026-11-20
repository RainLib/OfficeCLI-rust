import { randomUUID } from "node:crypto";
import { check, iso, uuid } from "./store.mjs";

const roles = new Set(["manager", "editor", "viewer"]);

function nameOf(value) {
  const name = typeof value === "string" ? value.trim().normalize("NFC") : "";
  check(name && [...name].length <= 80 && !/[\p{Cc}/\\]/u.test(name), 400, "请输入有效的名称。");
  return name;
}

export function createProjects(store) {
  function project(user, id, required) {
    check(uuid(id), 400, "项目 ID 无效。");
    const role = store.projectRole(user, id);
    check(role, 404, "项目不存在或无权访问。");
    if (required === "manager") check(role === "manager", 403, "需要项目管理权限。");
    if (required === "editor") check(role !== "viewer", 403, "需要项目编辑权限。");
    const row = store.get("SELECT id,name,owner_id AS ownerId FROM projects WHERE id=?", id);
    return { ...row, role };
  }

  function list(user) {
    const rows = store.all(`SELECT p.id,p.name,p.owner_id AS ownerId,m.role FROM projects p
      LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=?
      WHERE ?='admin' OR p.owner_id=? OR m.role IS NOT NULL ORDER BY p.name COLLATE NOCASE,p.id`,
    user.id, user.role, user.id);
    return rows.map(row => ({ ...row, role: user.role === "admin" || row.ownerId === user.id ? "manager" : row.role }));
  }

  function create(user, value) {
    const id = randomUUID(), name = nameOf(value?.name);
    store.transaction(() => {
      store.run("INSERT INTO projects VALUES(?,?,?,?)", id, name, user.id, iso());
      store.audit(user.id, "project.created", id);
    });
    return { id, name, ownerId: user.id, role: "manager" };
  }

  function details(user, id) {
    const info = project(user, id);
    const folders = store.all(`SELECT id,name,parent_id AS parentId FROM project_folders
      WHERE project_id=? ORDER BY name COLLATE NOCASE,id`, id);
    return { project: info, folders };
  }

  function rename(user, id, value) {
    return store.transaction(() => {
      const info = project(user, id, "manager"), name = nameOf(value?.name);
      store.run("UPDATE projects SET name=? WHERE id=?", name, id);
      store.audit(user.id, "project.renamed", id);
      return { ...info, name };
    });
  }

  function members(user, id) {
    const info = project(user, id);
    const roster = store.all(`SELECT id,display_name AS name,'owner' AS role,disabled FROM users WHERE id=?
      UNION ALL SELECT u.id,u.display_name,m.role,u.disabled FROM users u
      JOIN project_members m ON m.user_id=u.id WHERE m.project_id=? ORDER BY name,id`,
    info.ownerId, id);
    const directory = info.role === "manager" ? store.all(`SELECT u.id,u.display_name AS name,u.username FROM users u
      WHERE u.disabled=0 AND NOT EXISTS (SELECT 1 FROM guest_identities WHERE user_id=u.id)
      ORDER BY u.display_name,u.id`) : [];
    return { members: roster, directory };
  }

  function setMember(user, id, memberId, role) {
    check(uuid(memberId) && (roles.has(role) || role === null), 400, "成员或项目角色无效。");
    store.transaction(() => {
      const info = project(user, id, "manager");
      check(memberId !== info.ownerId, 409, "项目所有者的权限由项目归属决定。");
      if (role === null) {
        store.run("DELETE FROM project_members WHERE project_id=? AND user_id=?", id, memberId);
      } else {
        check(!store.user(memberId).is_guest, 400, "请邀请工作空间成员。");
        store.run(`INSERT INTO project_members VALUES(?,?,?) ON CONFLICT(project_id,user_id)
          DO UPDATE SET role=excluded.role`, id, memberId, role);
      }
      store.audit(user.id, role === null ? "project.member.removed" : "project.member.updated", id);
    });
  }

  function folder(projectId, id) {
    if (id === null) return null;
    check(uuid(id), 400, "文件夹 ID 无效。");
    const row = store.get(`SELECT id,name,parent_id AS parentId FROM project_folders
      WHERE project_id=? AND id=?`, projectId, id);
    check(row, 404, "该项目中没有此文件夹。");
    return row;
  }

  function saveFolder(user, projectId, value, id = null) {
    return store.transaction(() => {
      project(user, projectId, "editor");
      const existing = folder(projectId, id);
      const name = nameOf(value?.name ?? existing?.name);
      const parentId = value && Object.hasOwn(value, "parentId") ? value.parentId : existing?.parentId ?? null;
      folder(projectId, parentId);
      if (id && parentId) {
        const cycle = store.get(`WITH RECURSIVE parents(id,parent_id) AS (
          SELECT id,parent_id FROM project_folders WHERE id=? AND project_id=?
          UNION
          SELECT f.id,f.parent_id FROM project_folders f JOIN parents p ON f.id=p.parent_id WHERE f.project_id=?
        ) SELECT 1 FROM parents WHERE id=?`, parentId, projectId, projectId, id);
        check(!cycle, 409, "文件夹不能移到自身或子文件夹。");
      }
      const duplicate = store.get(`SELECT 1 FROM project_folders WHERE project_id=?
        AND parent_id IS ? AND name=? COLLATE NOCASE AND id<>?`, projectId, parentId, name, id ?? "");
      check(!duplicate, 409, "同一位置已有同名文件夹。");
      const folderId = id ?? randomUUID();
      if (existing) store.run("UPDATE project_folders SET name=?,parent_id=? WHERE id=?", name, parentId, id);
      else store.run("INSERT INTO project_folders VALUES(?,?,?,?)", folderId, projectId, parentId, name);
      store.audit(user.id, existing ? "project.folder.updated" : "project.folder.created", folderId);
      return { id: folderId, name, parentId };
    });
  }

  function removeFolder(user, projectId, id) {
    store.transaction(() => {
      project(user, projectId, "editor");
      folder(projectId, id);
      check(!store.get("SELECT 1 FROM project_files WHERE project_id=? AND folder_id=? LIMIT 1", projectId, id) &&
        !store.get("SELECT 1 FROM project_folders WHERE project_id=? AND parent_id=? LIMIT 1", projectId, id),
      409, "请先移出该文件夹里的文件和子文件夹。");
      store.run("DELETE FROM project_folders WHERE project_id=? AND id=?", projectId, id);
      store.audit(user.id, "project.folder.removed", id);
    });
  }

  function destination(user, { projectId = null, folderId = null } = {}) {
    if (projectId === null) {
      check(folderId === null, 400, "文件夹需要属于一个项目。");
      return null;
    }
    project(user, projectId, "editor");
    folder(projectId, folderId);
    return { projectId, folderId };
  }

  function visibleLocation(user, fileId) {
    const location = store.fileLocation(fileId);
    return location && store.projectRole(user, location.projectId) ? location : null;
  }

  function moveFile(user, file, value) {
    check(value && Object.hasOwn(value, "projectId"), 400, "请选择文件的新位置。");
    store.transaction(() => {
      const to = destination(user, value);
      const before = store.fileLocation(file.id);
      if (!to || to.projectId !== before?.projectId) store.manage(user, file);
      else store.permit(user, file, "document.view", "document.edit");
      if (to) store.run(`INSERT INTO project_files VALUES(?,?,?) ON CONFLICT(file_id)
        DO UPDATE SET project_id=excluded.project_id,folder_id=excluded.folder_id`, file.id, to.projectId, to.folderId);
      else store.run("DELETE FROM project_files WHERE file_id=?", file.id);
      store.audit(user.id, "project.file.moved", file.id);
    });
  }

  return { list, create, details, rename, members, setMember, saveFolder, removeFolder, destination, visibleLocation, moveFile };
}

import { randomUUID } from "node:crypto";
import { foldName } from "./business-schema.mts";
import { check, iso, uuid } from "./store.mts";
import type { FileRow, ProjectRole, Store, WorkspaceUser } from "./store.mts";

const roles = new Set<ProjectRole>(["manager", "editor", "viewer"]);

interface ProjectRow {
  id: string;
  name: string;
  ownerId: string;
}

interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
}

interface Destination {
  projectId?: string | null;
  folderId?: string | null;
}

function nameOf(value: unknown) {
  const name = typeof value === "string" ? value.trim().normalize("NFC") : "";
  check(name && [...name].length <= 80 && !/[\p{Cc}/\\]/u.test(name), 400, "请输入有效的名称。");
  return name;
}

export function createProjects(store: Store) {
  const projectName = foldName(store.kind, "p.name"), folderName = foldName(store.kind, "name");
  async function project(user: WorkspaceUser, id: unknown, required?: "manager" | "editor") {
    check(uuid(id), 400, "项目 ID 无效。");
    const role = await store.projectRole(user, id);
    check(role, 404, "项目不存在或无权访问。");
    if (required === "manager") check(role === "manager", 403, "需要项目管理权限。");
    if (required === "editor") check(role !== "viewer", 403, "需要项目编辑权限。");
    const row = await store.get<ProjectRow>('SELECT id,name,owner_id AS "ownerId" FROM projects WHERE id=?', id);
    check(row, 404, "项目不存在或无权访问。");
    return { ...row, role };
  }

  async function list(user: WorkspaceUser) {
    const rows = await store.all<ProjectRow & { role: ProjectRole | null }>(`SELECT p.id,p.name,p.owner_id AS "ownerId",m.role FROM projects p
      LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=?
      WHERE ?='admin' OR p.owner_id=? OR m.role IS NOT NULL ORDER BY ${projectName},p.id`,
    user.id, user.role, user.id);
    return rows.map(row => ({ ...row, role: user.role === "admin" || row.ownerId === user.id ? "manager" : row.role }));
  }

  async function create(user: WorkspaceUser, value: { name?: unknown } | null) {
    const id = randomUUID(), name = nameOf(value?.name);
    await store.transaction(async () => {
      check(!(await store.user(user.id)).is_guest, 403, "创建项目需要工作空间成员权限。");
      await store.run("INSERT INTO projects VALUES(?,?,?,?)", id, name, user.id, iso());
      await store.audit(user.id, "project.created", id);
    });
    return { id, name, ownerId: user.id, role: "manager" };
  }

  async function details(user: WorkspaceUser, id: string) {
    const info = await project(user, id);
    const folders = await store.all<FolderRow>(`SELECT id,name,parent_id AS "parentId" FROM project_folders
      WHERE project_id=? ORDER BY ${folderName},id`, id);
    return { project: info, folders };
  }

  async function rename(user: WorkspaceUser, id: string, value: { name?: unknown } | null) {
    return store.transaction(async () => {
      const info = await project(user, id, "manager"), name = nameOf(value?.name);
      await store.run("UPDATE projects SET name=? WHERE id=?", name, id);
      await store.audit(user.id, "project.renamed", id);
      return { ...info, name };
    });
  }

  async function members(user: WorkspaceUser, id: string) {
    const info = await project(user, id);
    const roster = await store.all<{ id: string, name: string, role: ProjectRole | "owner", disabled: number }>(`SELECT id,display_name AS name,'owner' AS role,disabled FROM users WHERE id=?
      UNION ALL SELECT u.id,u.display_name,m.role,u.disabled FROM users u
      JOIN project_members m ON m.user_id=u.id WHERE m.project_id=? ORDER BY name,id`,
    info.ownerId, id);
    const directory = info.role === "manager" ? await store.all<{ id: string, name: string, username: string }>(`SELECT u.id,u.display_name AS name,u.username FROM users u
      WHERE u.disabled=0 AND NOT EXISTS (SELECT 1 FROM guest_identities WHERE user_id=u.id)
      ORDER BY u.display_name,u.id`) : [];
    return { members: roster, directory };
  }

  async function setMember(user: WorkspaceUser, id: string, memberId: unknown, role: ProjectRole | null) {
    check(uuid(memberId) && (role === null || roles.has(role)), 400, "成员或项目角色无效。");
    await store.transaction(async () => {
      const info = await project(user, id, "manager");
      check(memberId !== info.ownerId, 409, "项目所有者的权限由项目归属决定。");
      if (role === null) {
        await store.run("DELETE FROM project_members WHERE project_id=? AND user_id=?", id, memberId);
      } else {
        check(!(await store.user(memberId)).is_guest, 400, "请邀请工作空间成员。");
        await store.upsert("project_members", ["project_id", "user_id"], { project_id: id, user_id: memberId, role });
      }
      await store.audit(user.id, role === null ? "project.member.removed" : "project.member.updated", id);
    });
  }

  async function folder(projectId: string, id: unknown) {
    if (id === null) return null;
    check(uuid(id), 400, "文件夹 ID 无效。");
    const row = await store.get<FolderRow>(`SELECT id,name,parent_id AS "parentId" FROM project_folders
      WHERE project_id=? AND id=?`, projectId, id);
    check(row, 404, "该项目中没有此文件夹。");
    return row;
  }

  async function saveFolder(user: WorkspaceUser, projectId: string, value: { name?: unknown, parentId?: unknown } | null, id: string | null = null) {
    return store.transaction(async () => {
      await project(user, projectId, "editor");
      const existing = await folder(projectId, id);
      const name = nameOf(value?.name ?? existing?.name);
      const parent = await folder(projectId, value && Object.hasOwn(value, "parentId") ? value.parentId : existing?.parentId ?? null);
      const parentId = parent?.id ?? null;
      if (id && parentId) {
        const cycle = await store.get(`WITH RECURSIVE parents(id,parent_id) AS (
          SELECT id,parent_id FROM project_folders WHERE id=? AND project_id=?
          UNION
          SELECT f.id,f.parent_id FROM project_folders f JOIN parents p ON f.id=p.parent_id WHERE f.project_id=?
        ) SELECT 1 FROM parents WHERE id=?`, parentId, projectId, projectId, id);
        check(!cycle, 409, "文件夹不能移到自身或子文件夹。");
      }
      const duplicate = await store.get(`SELECT 1 FROM project_folders WHERE project_id=?
        AND COALESCE(parent_id,'')=COALESCE(?,'') AND ${folderName}=? AND id<>?`,
        projectId, parentId, name.replace(/[A-Z]/g, char => char.toLowerCase()), id ?? "");
      check(!duplicate, 409, "同一位置已有同名文件夹。");
      const folderId = id ?? randomUUID();
      if (existing) await store.run("UPDATE project_folders SET name=?,parent_id=? WHERE id=?", name, parentId, folderId);
      else await store.run("INSERT INTO project_folders VALUES(?,?,?,?)", folderId, projectId, parentId, name);
      await store.audit(user.id, existing ? "project.folder.updated" : "project.folder.created", folderId);
      return { id: folderId, name, parentId };
    });
  }

  async function removeFolder(user: WorkspaceUser, projectId: string, id: string) {
    await store.transaction(async () => {
      await project(user, projectId, "editor");
      await folder(projectId, id);
      check(!await store.get("SELECT 1 FROM project_files WHERE project_id=? AND folder_id=? LIMIT 1", projectId, id) &&
        !await store.get("SELECT 1 FROM project_folders WHERE project_id=? AND parent_id=? LIMIT 1", projectId, id),
      409, "请先移出该文件夹里的文件和子文件夹。");
      await store.run("DELETE FROM project_folders WHERE project_id=? AND id=?", projectId, id);
      await store.audit(user.id, "project.folder.removed", id);
    });
  }

  async function destination(user: WorkspaceUser, { projectId = null, folderId = null }: Destination = {}) {
    if (projectId === null) {
      check(folderId === null, 400, "文件夹需要属于一个项目。");
      return null;
    }
    await project(user, projectId, "editor");
    await folder(projectId, folderId);
    return { projectId, folderId };
  }

  async function moveFile(user: WorkspaceUser, file: FileRow, value: Destination | null) {
    check(value && Object.hasOwn(value, "projectId"), 400, "请选择文件的新位置。");
    await store.transaction(async () => {
      const to = await destination(user, value);
      const before = await store.fileLocation(file.id);
      if (!to || to.projectId !== before?.projectId) await store.manage(user, file);
      else await store.permit(user, file, "document.view", "document.edit");
      if (to) await store.upsert("project_files", ["file_id"], { file_id: file.id, project_id: to.projectId, folder_id: to.folderId });
      else await store.run("DELETE FROM project_files WHERE file_id=?", file.id);
      await store.audit(user.id, "project.file.moved", file.id);
    });
  }

  return { list, create, details, rename, members, setMember, saveFolder, removeFolder, destination, moveFile };
}

import { randomUUID } from "node:crypto";
import { check, now, uuid } from "./store.mjs";
import { prepareUndo, undoIntent } from "./workbench-undo.mjs";
import { combineFileActions } from "./workbench-planner.mjs";

const runnable = (target) => ["queued", "editing"].includes(target.phase);
const dependencyTargets = (job, target) =>
  (target.step?.dependsOn || []).map(id => job.targets.find(item => item.id === id));
const dependenciesReady = (job, target) =>
  dependencyTargets(job, target).every(item => item?.phase === "complete" && item.undoReceipt === undefined);
const draftable = (job, target) =>
  ["waiting", "drafting"].includes(target.phase) && dependenciesReady(job, target);
const jobActive = (job) => job.targets.some(target => runnable(target) || draftable(job, target));
const describeScope = (grant) => {
  switch (grant.target.kind) {
    case "append": return grant.format === "excalidraw" ? "追加到白板" : "追加到文末";
    case "spec": return "Spec 选句";
    case "sheet": return "表格选区";
    case "document": return "正文选区";
    default: return `${grant.target.elementIds.length} 个白板对象`;
  }
};

export function createWorkbenchJobs({ store, grants, launch, engine, planFile }) {
  const running = new Map();
  const planning = new Map();
  const undoing = new Set();
  let paused = false;

  const state = (id) => {
    const row = store.get("SELECT state FROM workbench_jobs WHERE id=?", id);
    return row ? JSON.parse(row.state) : null;
  };
  const save = (job) => {
    store.run("UPDATE workbench_jobs SET state=? WHERE id=? AND owner_id=?", JSON.stringify(job), job.id, job.owner);
  };
  const saveTarget = (jobId, target) => {
    const latest = state(jobId);
    latest.targets = latest.targets.map(item => item.id === target.id ? target : item);
    save(latest);
    return latest;
  };
  const visible = (job, user) => job.owner === user.id && job.targets.every(target =>
    store.permissions(user, store.file(target.id)).includes("document.view"));
  const expose = (job) => ({
    id: job.id, prompt: job.prompt, reply: job.reply, createdAt: job.createdAt,
    done: !jobActive(job),
    targets: job.targets.map(target => {
      const { id, name, format, scope, phase, prepared, receipt, error, undoReceipt, needsReview } = target;
      const dependsOn = dependencyTargets(job, target).map(item => ({
        id: item.id, name: item.name, revision: item.receipt, undone: item.undoReceipt !== undefined,
      }));
      return {
        id, name, format, scope, phase, receipt, error, undoReceipt,
        ...(dependsOn.length && { dependsOn, dependencyBlocked: !dependenciesReady(job, target) }),
        ...(phase === "review" && { changes: prepared.preview, reviewId: prepared.data.patchId }),
        ...(phase === "failed" && prepared && !needsReview && { retryable: true }),
        ...(phase === "failed" && (needsReview || !prepared) && { recheckable: true }),
        ...(receipt !== undefined && { undoable: !!(undoIntent(prepared) || prepared?.specUndo), specUndo: !!prepared?.specUndo }),
      };
    }),
  });
  const accountFor = (job) => {
    const session = store.get("SELECT * FROM sessions WHERE hash=? AND user_id=? AND expires>?", job.browser, job.owner, now());
    check(session, 401, "请重新登录后继续任务。");
    return { ...session, user: store.user(job.owner) };
  };

  function get(account, id) {
    const job = uuid(id) && state(id);
    check(job && visible(job, account.user), 404, "任务不存在或相关文件的权限已改变。");
    return job;
  }

  function authorizeJob(job, account) {
    for (const target of job.targets)
      store.permit(account.user, store.file(target.id), "document.view", "document.ai");
  }

  function adopt(job, account) {
    if (job.browser === account.hash) return;
    job.browser = account.hash;
    for (const target of job.targets) target.launchId = randomUUID();
  }

  async function prepare(grant, id, actions) {
    check(actions.length, 409, "当前选区没有可审核的修改。");
    const action = combineFileActions(actions);
    const prepared = await grants.prepareReview(grant, id, action.tool, action.args);
    if (grant.target.kind === "spec") prepared.specUndo = { id: grant.target.id, epoch: grant.epoch };
    return prepared;
  }

  async function create(account, id, prompt, compile) {
    check(uuid(id), 400, "任务 ID 无效。");
    const prior = state(id);
    if (prior) {
      check(visible(prior, account.user) && prior.prompt === prompt, 409, "任务 ID 已用于其他请求。");
      return expose(prior);
    }
    const inFlight = planning.get(id);
    if (inFlight) {
      check(inFlight.owner === account.user.id && inFlight.prompt === prompt, 409, "任务 ID 已用于其他请求。");
      return inFlight.result;
    }
    const result = (async () => {
      const { plan, selections, sources = [] } = await compile();
      const targets = await Promise.all(selections.map(async (grant) => {
        const target = {
          id: grant.fileId, name: grant.name, format: grant.format, scope: describeScope(grant),
          phase: "reading", launchId: randomUUID(),
        };
        const actions = plan.actions.filter(action => action.fileId === grant.fileId);
        const step = plan.steps?.find(item => item.fileId === grant.fileId);
        if (!actions.length && !step) return target;
        try {
          target.selection = grants.snapshot(grant);
          if (step) {
            target.step = step;
            target.phase = "waiting";
          } else {
            target.prepared = await prepare(grant, id, actions);
            target.phase = "review";
          }
        } catch (error) {
          target.phase = "failed";
          target.error = error.status ? error.message : "计划含无法应用的文件操作。";
        }
        return target;
      }));
      const job = { id, owner: account.user.id, browser: account.hash, prompt, reply: plan.reply,
        agent: { id: randomUUID(), name: "墨点" }, createdAt: Date.now(), targets, sources };
      store.run("INSERT INTO workbench_jobs VALUES(?,?,?,?)", id, job.owner, job.createdAt, JSON.stringify(job));
      schedule(job);
      return expose(job);
    })();
    planning.set(id, { owner: account.user.id, prompt, result });
    try { return await result; } finally { planning.delete(id); }
  }

  async function readReceipt(token, prepared, includeAdded = false) {
    const { documentId, patchId, baseRevision } = prepared.data;
    try {
      const query = `baseRevision=${baseRevision}${includeAdded ? "&includeAdded=true" : ""}`;
      const found = await engine(`/v1/documents/${documentId}/patch-receipts/${patchId}?${query}`, { token });
      check(found.patchId === patchId && Number.isSafeInteger(found.revision) && found.revision > baseRevision,
        502, "编辑服务返回了不匹配的修订回执。");
      return found;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const knownReceipt = async (token, prepared) => (await readReceipt(token, prepared))?.revision;

  async function draft(jobId, fileId) {
    const job = state(jobId);
    const target = job?.targets.find(item => item.id === fileId);
    if (!target || !draftable(job, target)) return;
    target.phase = "drafting";
    delete target.error;
    save(job);
    try {
      const account = accountFor(job);
      authorizeJob(job, account);
      const file = store.file(target.id);
      store.permit(account.user, file, "document.edit");
      const access = await launch(account, file, target.launchId);
      const prior = target.prepared;
      if (prior && target.attempted) {
        check(prior.data.documentId === access.documentId, 409, "目标文件已被替换。");
        const revision = await knownReceipt(access.token, prior);
        if (revision !== undefined) {
          target.receipt = revision;
          target.phase = "complete";
          delete target.needsReview;
          saveTarget(jobId, target);
          return;
        }
      }
      const prerequisite = dependencyTargets(job, target);
      const facts = prerequisite.map(item => ({
        fileId: item.id, file: item.name, revision: item.receipt,
        changes: item.prepared.preview.map(({ label, after }) => ({ label, after })),
      }));
      const sources = (job.sources || []).filter(item =>
        item.fileId !== fileId && !prerequisite.some(parent => parent.id === item.fileId));
      await grants.withWorkbenchSelection(account, file, target.launchId, access, target.selection, async grant => {
        const input = { fileId, ...(await grants.call(grant, "read_selection", {})) };
        const actions = await planFile({
          prompt: job.prompt, target: input, sources, facts, task: target.step?.task, previousChanges: prior?.preview,
        });
        authorizeJob(job, accountFor(job));
        const prepared = await prepare(grant, job.id, actions);
        target.selection = grants.snapshot(grant);
        target.prepared = prepared;
        target.scope = describeScope(grant);
        delete target.attempted;
        delete target.needsReview;
        target.phase = "review";
      });
    } catch (error) {
      target.phase = "failed";
      target.needsReview = true;
      target.error = error.status ? error.message : "无法生成此文件的修改预览。";
    }
    saveTarget(jobId, target);
  }

  async function execute(jobId, fileId) {
    const job = state(jobId);
    const target = job?.targets.find(item => item.id === fileId);
    if (!target || !runnable(target)) return;
    const prepared = target.prepared;
    const recovering = target.phase === "editing" || target.attempted;
    target.phase = "editing";
    target.attempted = true;
    delete target.error;
    save(job);
    const finish = grants.startActivity(job.owner, fileId, prepared.data.patchId, job.agent.name);
    try {
      const account = accountFor(job);
      authorizeJob(job, account);
      check(dependenciesReady(job, target), 409, "依赖的修改尚未保存或已撤销。");
      const file = store.file(target.id);
      store.permit(account.user, file, "document.edit");
      const access = await launch(account, file, target.launchId);
      check(prepared.data.documentId === access.documentId, 409, "目标文件已被替换。");
      let revision = recovering ? await knownReceipt(access.token, prepared) : undefined;
      if (revision === undefined) {
        try {
          const applied = await grants.commitPrepared(access.token, prepared, job.agent);
          revision = applied.revision ?? applied.newRevision;
        } catch (error) {
          revision = await knownReceipt(access.token, prepared).catch(() => undefined);
          if (revision === undefined) throw error;
        }
      }
      check(Number.isSafeInteger(revision) && revision > prepared.data.baseRevision, 502, "缺少有效的编辑回执。");
      target.receipt = revision;
      target.phase = "complete";
    } catch (error) {
      target.phase = "failed";
      target.needsReview = [409, 412].includes(error.status);
      target.error = error.status ? error.message : "暂时无法确认提交结果，可以重试该文件。";
    }
    saveTarget(jobId, target);
    finish(target.receipt);
    if (target.phase === "complete") store.audit(job.owner, "workbench.job.applied", target.id);
  }

  function schedule(job) {
    if (paused || running.has(job.id) || !jobActive(job)) return;
    const task = Promise.resolve().then(async () => {
      let current = state(job.id);
      while (!paused && current && jobActive(current)) {
        const work = current.targets.flatMap(target => runnable(target)
          ? [execute(job.id, target.id)]
          : draftable(current, target) ? [draft(job.id, target.id)] : []);
        await Promise.all(work);
        current = state(job.id);
      }
    });
    running.set(job.id, task);
    void task.catch(() => {}).finally(() => running.delete(job.id));
  }

  function list(account) {
    const jobs = store.all("SELECT state FROM workbench_jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 30", account.user.id)
      .map(row => JSON.parse(row.state)).filter(job => visible(job, account.user));
    return jobs.reverse().map(expose);
  }

  function resume() {
    paused = false;
    const jobs = store.all(`SELECT state FROM workbench_jobs WHERE EXISTS (
      SELECT 1 FROM json_each(state, '$.targets') WHERE json_extract(value, '$.phase') IN ('queued', 'editing', 'waiting', 'drafting')
    )`);
    for (const row of jobs) schedule(JSON.parse(row.state));
  }

  function pause() {
    paused = true;
    return Promise.allSettled([...running.values()]);
  }

  function transition(account, id, action, requested, reviews) {
    const job = get(account, id);
    check(!running.has(id) && !jobActive(job) && !undoing.has(id), 409, "该任务仍在执行。");
    const phase = action === "approve" ? "review" : "failed";
    const allowed = job.targets.filter(target => target.prepared && target.phase === phase &&
      (action === "approve" || !target.needsReview) && dependenciesReady(job, target));
    check(Array.isArray(requested) && requested.length > 0 && new Set(requested).size === requested.length &&
      requested.every(file => allowed.some(target => target.id === file)), 400, "请选择本次可执行的文件。");
    const chosen = new Set(requested);
    if (action === "approve") check(reviews && typeof reviews === "object" &&
      allowed.every(target => !chosen.has(target.id) || reviews[target.id] === target.prepared.data.patchId),
    409, "修改预览已更新，请重新核对后再应用。");
    adopt(job, account);
    for (const target of allowed) {
      if (!chosen.has(target.id)) continue;
      store.permit(account.user, store.file(target.id), "document.view", "document.edit", "document.ai");
      target.phase = "queued";
      delete target.error;
    }
    save(job);
    const view = expose(job);
    schedule(job);
    return view;
  }

  function recheck(account, id, requested, grant) {
    const job = get(account, id);
    check(!running.has(id) && !jobActive(job) && !undoing.has(id), 409, "该任务仍在执行。");
    const target = Array.isArray(requested) && requested.length === 1 && job.targets.find(item => item.id === requested[0]);
    check(target?.phase === "failed" && (target.needsReview || !target.prepared), 409, "请选择需要重新核对的文件。");
    check(dependenciesReady(job, target), 409, "依赖的修改尚未保存或已撤销。");
    authorizeJob(job, account);
    store.permit(account.user, store.file(target.id), "document.edit");
    if (grant) {
      check(grant.fileId === target.id && grant.userId === account.user.id && grant.browser === account.hash &&
        (!target.selection || target.selection.target.kind === grant.target.kind),
      403, "请为同一文件确认同一种选区。");
      target.selection = grants.snapshot(grant);
      target.scope = describeScope(grant);
    }
    check(target.selection, 409, "请打开此文件并重新确认选区。");
    adopt(job, account);
    target.phase = "drafting";
    delete target.error;
    save(job);
    schedule(job);
    return expose(job);
  }

  async function undo(account, id, requested) {
    check(Array.isArray(requested) && requested.length === 1 && uuid(requested[0]), 400, "请选择一次要撤销的修改。");
    const job = get(account, id);
    const target = job.targets.find(item => item.id === requested[0]);
    const prepared = target?.prepared;
    const intent = undoIntent(prepared);
    check(target?.phase === "complete" && (intent || prepared?.specUndo), 409, "此修改暂不支持单独撤销。");
    const file = store.file(target.id);
    store.permit(account.user, file, "document.view", "document.edit", "document.ai");
    if (target.undoReceipt !== undefined) return expose(job);
    check(!running.has(id) && !jobActive(job) && !undoing.has(id), 409, "该任务仍在执行。");
    undoing.add(id);
    try {
      const { token, documentId } = await launch(account, file, randomUUID());
      check(documentId === prepared.data.documentId, 409, "目标文件已被替换。");
      let revision;
      if (prepared.specUndo) {
        const applied = await engine(`/v1/documents/${documentId}/canvas/spec-undo`, {
          token, method: "POST", headers: { "X-HCD-Collaboration-Epoch": String(prepared.epoch) },
          data: { id: prepared.specUndo.id, revision: target.receipt },
        });
        revision = applied.revision;
      } else {
        if (target.inverse) revision = await knownReceipt(token, target.inverse);
        else {
          let receipt;
          if (intent.kind.endsWith("-append") || (intent.kind === "sheet" && intent.edits.some(edit => edit.created))) {
            receipt = await readReceipt(token, prepared, true);
            check(receipt?.revision === target.receipt, 409, "无法核对本次新增的修订回执。");
          }
          target.inverse = await prepareUndo(engine, token, prepared, receipt);
          saveTarget(id, target);
        }
        if (revision === undefined) {
          try {
            const applied = await grants.commitPrepared(token, target.inverse, job.agent);
            revision = applied.revision ?? applied.newRevision;
          } catch (error) {
            revision = await knownReceipt(token, target.inverse);
            if (revision === undefined) {
              if ([409, 412].includes(error.status)) {
                delete target.inverse;
                saveTarget(id, target);
              }
              throw error;
            }
          }
        }
      }
      check(Number.isSafeInteger(revision) && revision > target.receipt, 502, "缺少有效的撤销回执。");
      target.undoReceipt = revision;
      delete target.inverse;
      const saved = saveTarget(id, target);
      store.audit(job.owner, "workbench.job.undone", target.id);
      return expose(saved);
    } finally { undoing.delete(id); }
  }

  return { create, list, transition, recheck, pause, resume, undo };
}

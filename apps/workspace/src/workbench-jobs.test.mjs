import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { HttpError, now, Store } from "./store.mts";
import { createWorkbenchJobs } from "./workbench-jobs.mjs";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "officecli-jobs-"));
  const store = await Store.open(root, { initialize: async () => {} });
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = randomUUID(), other = randomUUID(), session = randomUUID();
  for (const id of [owner, other]) await store.run(
    "INSERT INTO users(id,username,display_name,password,role,created_at) VALUES(?,?,?,?,?,?)",
    id, id, "工作坊", "unused", "member", "2026-11-20",
  );
  await store.run("INSERT INTO sessions VALUES(?,?,?,?,?)", session, owner, "unused", now() + 300, now());
  const contents = ["会议纪要.docx", "计划.docx"].map(name => ({ fileId: randomUUID(), name, format: "docx", target: { kind: "append" } }));
  for (const { fileId, name } of contents) await store.run(
    "INSERT INTO files VALUES(?,?,?,?,?,?,?,?)", fileId, name, "docx", "application/octet-stream", owner, 0, "2026-11-20", "2026-11-20",
  );
  const account = { hash: session, user: await store.user(owner) };
  const plan = (ids) => async () => ({
    selections: contents,
    plan: { reply: "", actions: contents.map(({ fileId }, i) => ({ fileId, tool: "append_to_file", args: { requestId: ids[i], text: "下一步" } })) },
  });
  const revisions = new Map(), attempts = [];
  const dependencies = {
    store,
    launch: async (_, file) => ({ token: "test:" + file.id, documentId: file.id }),
    engine: async (path, { token }) => {
      const [, , , fileId, , tail] = path.split("/");
      const patchId = tail.split("?")[0];
      assert.equal(token, "test:" + fileId);
      const previous = revisions.get(patchId);
      if (!previous) throw new HttpError(404, "回执不存在");
      return { patchId, revision: previous };
    },
    grants: {
      startActivity: () => () => {},
      snapshot: grant => ({ documentId: grant.fileId, target: grant.target, revision: 1, collaborationEpoch: 1 }),
      withWorkbenchSelection: async (_, file, _launchId, _access, saved, use) => {
        assert.equal(saved.documentId, file.id);
        return use(contents.find(item => item.fileId === file.id));
      },
      call: async grant => ({ file: grant.name, kind: grant.target.kind, revision: 1 }),
      prepareReview: async (grant, _jobId, _tool, args) => ({
        data: { patchId: args.requestId, documentId: grant.fileId, baseRevision: 1 },
        preview: [{ label: "新增内容", before: "", after: args.text }],
      }),
      commitPrepared: async (_, change) => {
        const { documentId, patchId } = change.data;
        attempts.push([documentId, patchId]);
        revisions.set(patchId, 2);
        return { revision: 2 };
      },
    },
  };
  return { account, other: { user: await store.user(other) }, contents, plan, dependencies, revisions, attempts };
}

async function settled(jobs, account) {
  for (let i = 0; i < 80; i++) {
    const result = (await jobs.list(account)).at(-1);
    if (result?.done) return result;
    await delay(10);
  }
  assert.fail("Expected the server task to settle");
}

test("approval reserves the exact patch and retry runs only the failed file", async t => {
  const { account, other, contents, plan, dependencies, attempts } = await fixture(t);
  const [first, second] = contents.map(item => item.fileId);
  const [firstPatch, secondPatch] = [randomUUID(), randomUUID()];
  const commit = dependencies.grants.commitPrepared;
  let failOnce = true;
  dependencies.grants.commitPrepared = (token, prepared) => {
    if (prepared.data.documentId === second && failOnce) {
      failOnce = false;
      attempts.push([second, prepared.data.patchId]);
      throw new HttpError(503, "编辑服务暂时不可用");
    }
    return commit(token, prepared);
  };
  const jobs = createWorkbenchJobs(dependencies), id = randomUUID();
  const waiting = await jobs.create(account, id, "追加下一步", plan([firstPatch, secondPatch]));
  assert.deepEqual(waiting.targets.map(item => item.phase), ["review", "review"]);
  assert.equal(waiting.targets[0].changes[0].after, "下一步");
  assert.equal(attempts.length, 0);
  assert.deepEqual(await jobs.list(other), []);
  await assert.rejects(() => jobs.transition(other, id, "approve", [first]), { status: 404 });
  assert.deepEqual(await jobs.list(account), [waiting]);
  await jobs.transition(account, id, "approve", [first, second], { [first]: firstPatch, [second]: secondPatch });
  const partial = await settled(jobs, account);
  assert.deepEqual(partial.targets.map(item => item.phase), ["complete", "failed"]);
  assert.equal(partial.targets[1].retryable, true);
  await assert.rejects(() => jobs.transition(account, id, "retry", [first]), { status: 400 });
  await jobs.transition(account, id, "retry", [second]);
  assert.deepEqual((await settled(jobs, account)).targets.map(item => item.receipt), [2, 2]);
  assert.deepEqual(attempts, [[first, firstPatch], [second, secondPatch], [second, secondPatch]]);
});

test("a restarted worker recovers a committed result when its reply was lost", async t => {
  const { account, contents, plan, dependencies, revisions, attempts } = await fixture(t);
  const id = randomUUID(), patchId = randomUUID();
  const jobs = createWorkbenchJobs(dependencies);
  await jobs.create(account, id, "追加下一步", plan([patchId, randomUUID()]));
  const job = JSON.parse((await dependencies.store.get("SELECT state FROM workbench_jobs WHERE id=?", id)).state);
  job.targets[0].phase = "editing";
  revisions.set(patchId, 2);
  await dependencies.store.run("UPDATE workbench_jobs SET state=? WHERE id=?", JSON.stringify(job), id);
  const restarted = createWorkbenchJobs(dependencies);
  await restarted.resume();
  const result = await settled(restarted, account);
  assert.equal(result.targets[0].id, contents[0].fileId);
  assert.equal(result.targets[0].receipt, 2);
  assert.equal(result.targets[1].phase, "review");
  assert.deepEqual(attempts, []);
});

test("only confirmed prerequisites enable drafting and each dependent diff requires fresh approval", async t => {
  const { account, contents, plan, dependencies, attempts } = await fixture(t);
  const [first, second] = contents.map(item => item.fileId);
  const firstPatch = randomUUID(), secondPatch = randomUUID();
  const snapshots = [];
  dependencies.planFile = async input => {
    snapshots.push(input);
    return [{ fileId: second, tool: "append_to_file", args: { requestId: secondPatch, text: "汇总：" + input.facts[0].changes[0].after } }];
  };
  const jobs = createWorkbenchJobs(dependencies), id = randomUUID();
  const waiting = await jobs.create(account, id, "先记录结论，再汇总", async () => {
    const result = await plan([firstPatch, secondPatch])();
    result.plan.actions.pop();
    result.plan.steps = [{ fileId: second, dependsOn: [first], task: "汇总已保存的结论" }];
    return result;
  });
  assert.deepEqual(waiting.targets.map(t => t.phase), ["review", "waiting"]);
  await assert.rejects(() => jobs.transition(account, id, "approve", [second]), { status: 400 });
  assert.deepEqual(snapshots, []);
  await jobs.transition(account, id, "approve", [first], { [first]: firstPatch });
  const reviewed = await settled(jobs, account);
  assert.deepEqual(attempts, [[first, firstPatch]]);
  assert.deepEqual(reviewed.targets.map(t => t.phase), ["complete", "review"]);
  assert.equal(snapshots[0].task, "汇总已保存的结论");
  assert.equal(snapshots[0].facts[0].revision, 2);
  assert.equal(reviewed.targets[1].changes[0].after, "汇总：下一步");
  await jobs.transition(account, id, "approve", [second], { [second]: secondPatch });
  assert.deepEqual((await settled(jobs, account)).targets.map(t => t.receipt), [2, 2]);
  assert.deepEqual(attempts, [[first, firstPatch], [second, secondPatch]]);
});

test("rechecking a version conflict replaces only its proposal and keeps its sibling's receipt", async t => {
  const { account, contents, plan, dependencies, attempts } = await fixture(t);
  const [first, second] = contents.map(item => item.fileId);
  const [firstPatch, stalePatch, freshPatch] = [randomUUID(), randomUUID(), randomUUID()];
  const commit = dependencies.grants.commitPrepared;
  dependencies.grants.commitPrepared = (token, prepared) => {
    if (prepared.data.patchId === stalePatch) throw new HttpError(412, "版本已改变");
    return commit(token, prepared);
  };
  dependencies.planFile = async ({ target, previousChanges }) => {
    assert.equal(target.fileId, second);
    assert.equal(previousChanges[0].after, "下一步");
    return [{ fileId: second, tool: "append_to_file", args: { requestId: freshPatch, text: "重新核对的下一步" } }];
  };
  const jobs = createWorkbenchJobs(dependencies), id = randomUUID();
  await jobs.create(account, id, "追加下一步", plan([firstPatch, stalePatch]));
  await jobs.transition(account, id, "approve", [first, second], { [first]: firstPatch, [second]: stalePatch });
  const failed = await settled(jobs, account);
  assert.equal(failed.targets[1].recheckable, true);
  assert.equal(failed.targets[1].retryable, undefined);
  await assert.rejects(() => jobs.transition(account, id, "retry", [second]), { status: 400 });
  const restarted = createWorkbenchJobs(dependencies);
  await restarted.recheck(account, id, [second]);
  const previewed = await settled(restarted, account);
  assert.equal(previewed.targets[0].receipt, 2);
  assert.equal(previewed.targets[1].changes[0].after, "重新核对的下一步");
  assert.deepEqual(attempts, [[first, firstPatch]]);
  await assert.rejects(() => restarted.transition(account, id, "approve", [second], { [second]: stalePatch }), { status: 409 });
  await restarted.transition(account, id, "approve", [second], { [second]: freshPatch });
  assert.deepEqual((await settled(restarted, account)).targets.map(t => t.receipt), [2, 2]);
  assert.deepEqual(attempts, [[first, firstPatch], [second, freshPatch]]);
});

test("resume finishes an interrupted dependent preview without repeating its committed source", async t => {
  const { account, contents, plan, dependencies, attempts } = await fixture(t);
  const [first, second] = contents.map(item => item.fileId);
  const id = randomUUID();
  const firstPatch = randomUUID(), secondPatch = randomUUID();
  const jobs = createWorkbenchJobs(dependencies);
  await jobs.create(account, id, "从已保存的来源整理", async () => {
    const result = await plan([firstPatch, secondPatch])();
    result.plan.actions.pop();
    result.plan.steps = [{ fileId: second, dependsOn: [first], task: "整理" }];
    return result;
  });
  const persisted = JSON.parse((await dependencies.store.get("SELECT state FROM workbench_jobs WHERE id=?", id)).state);
  persisted.targets[0].phase = "complete";
  persisted.targets[0].receipt = 2;
  persisted.targets[1].phase = "drafting";
  await dependencies.store.run("UPDATE workbench_jobs SET state=? WHERE id=?", JSON.stringify(persisted), id);
  dependencies.planFile = async ({ target, facts }) => {
    assert.equal(target.fileId, second);
    assert.deepEqual(facts.map(fact => [fact.fileId, fact.revision]), [[first, 2]]);
    return [{ fileId: second, tool: "append_to_file", args: { requestId: secondPatch, text: "可核对的结果" } }];
  };
  const restarted = createWorkbenchJobs(dependencies);
  await restarted.resume();
  const recovered = await settled(restarted, account);
  assert.equal(recovered.targets[0].receipt, 2);
  assert.equal(recovered.targets[1].reviewId, secondPatch);
  assert.deepEqual(attempts, []);
});

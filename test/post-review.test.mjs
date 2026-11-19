// Runs the inline github-script from the reusable workflow against a mocked
// Octokit. Usage: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(root, '.github/workflows/codex-pr-review.yml'), 'utf8');

// The script is a YAML block scalar between two marker comments; strip its indent.
const block = /^( *)\/\/ --- begin post-review script.*\n([\s\S]*?)^ *\/\/ --- end post-review script ---$/m.exec(workflow);
assert.ok(block, 'post-review script markers not found in workflow');
const indent = block[1].length;
const script = block[2].split('\n').map((l) => l.slice(indent)).join('\n');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' line1',
  '-old2',
  '+new2',
  '+new3',
  ' line4',
  '@@ -20,2 +21,3 @@',
  ' ctx21',
  '+add22',
  ' ctx23',
  '\\ No newline at end of file',
].join('\n');

async function run({ message, maxPriority = '2', rejectInline = false }) {
  const calls = [];
  const github = {
    rest: {
      pulls: {
        listFiles: 'listFiles',
        createReview: async (args) => {
          calls.push(args);
          if (rejectInline && args.comments && args.comments.length) {
            const e = new Error('Unprocessable Entity: line could not be resolved');
            e.status = 422;
            throw e;
          }
          return { data: { id: calls.length } };
        },
      },
    },
    paginate: async (fn, args) => {
      assert.equal(fn, 'listFiles');
      assert.equal(args.pull_number, 7);
      return [{ filename: 'src/a.js', patch: PATCH }, { filename: 'bin.png' }];
    },
  };
  const logs = { info: [], warning: [] };
  const core = { info: (m) => logs.info.push(m), warning: (m) => logs.warning.push(m) };
  const context = { repo: { owner: 'o', repo: 'r' } };
  const saved = { ...process.env };
  Object.assign(process.env, {
    CODEX_FINAL_MESSAGE: message, HEAD_SHA: 'abcdef1234567890', PR_NUMBER: '7', MAX_PRIORITY: maxPriority,
  });
  try {
    await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
  } finally {
    process.env = saved;
  }
  return { calls, logs };
}

const finding = (o) => ({ priority: 1, title: 't', body: 'b', file: 'src/a.js', start_line: 2, end_line: 2, ...o });
const msg = (findings, extra = {}) => JSON.stringify({ summary: 'S', verdict: 'incorrect', findings, ...extra });

test('places in-diff findings inline, others in the body', async () => {
  const { calls } = await run({ message: msg([
    finding({ title: 'single', start_line: 3, end_line: 3 }),
    finding({ title: 'range', start_line: 2, end_line: 4 }),
    finding({ title: 'cross-hunk', start_line: 4, end_line: 22 }),
    finding({ title: 'outside', start_line: 10, end_line: 10 }),
    finding({ title: 'other file', file: './lib/b.js' }),
    finding({ title: 'binary', file: 'bin.png', start_line: 1, end_line: 1 }),
  ]) });
  assert.equal(calls.length, 1);
  const [r] = calls;
  assert.equal(r.event, 'COMMENT');
  assert.equal(r.commit_id, 'abcdef1234567890');
  assert.deepEqual(r.comments.map(c => [c.body.split('\n')[0], c.start_line, c.line]), [
    ['**[P1] single**', undefined, 3],
    ['**[P1] range**', 2, 4],
    ['**[P1] cross-hunk**', undefined, 22],
  ]);
  assert.ok(r.body.startsWith('<!-- codex-pr-review -->'));
  assert.match(r.body, /6 个问题/);
  assert.match(r.body, /无法定位到 diff 行的问题/);
  assert.match(r.body, /\[P1\] outside\*\* — `src\/a\.js:10`/);
  assert.match(r.body, /`lib\/b\.js:2`/);
  assert.match(r.body, /`bin\.png:1`/);
  assert.doesNotMatch(r.body, /single/);
});

test('removed lines are not commentable', async () => {
  // Head line 5 does not exist in the first hunk (it ends at 4); line 21 is context.
  const { calls } = await run({ message: msg([finding({ start_line: 5, end_line: 5 }), finding({ start_line: 21, end_line: 21 })]) });
  assert.deepEqual(calls[0].comments.map(c => c.line), [21]);
});

test('filters by max priority and sorts by priority', async () => {
  const { calls } = await run({ maxPriority: '1', message: msg([
    finding({ priority: 2, title: 'p2' }), finding({ priority: 0, title: 'p0', end_line: 3, start_line: 3 }),
    finding({ priority: 3, title: 'p3' }), finding({ priority: 1, title: 'p1', end_line: 22, start_line: 22 }),
  ]) });
  assert.deepEqual(calls[0].comments.map(c => c.body.split('\n')[0]), ['**[P0] p0**', '**[P1] p1**']);
  assert.match(calls[0].body, /2 个问题/);
  assert.match(calls[0].body, /另有 2 个低优先级建议未列出/);
  assert.match(calls[0].body, /列出 P0–P1/);
});

test('no findings posts a short clean review', async () => {
  const { calls } = await run({ message: msg([], { verdict: 'correct' }) });
  assert.equal(calls[0].comments.length, 0);
  assert.match(calls[0].body, /未发现问题/);
  assert.match(calls[0].body, /\nS\n/);
});

test('falls back to body-only review when GitHub rejects inline comments', async () => {
  const { calls, logs } = await run({ rejectInline: true, message: msg([finding({ title: 'x', start_line: 3, end_line: 3 })]) });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].comments, undefined);
  assert.match(calls[1].body, /#### 问题\n\n- \*\*\[P1\] x\*\* — `src\/a\.js:3`/);
  assert.equal(logs.warning.length, 1);
});

test('non-JSON output is posted as plain text', async () => {
  const { calls, logs } = await run({ message: 'Codex said something unstructured' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /Codex said something unstructured/);
  assert.equal(logs.warning.length, 1);
});

test('accepts JSON wrapped in a code fence', async () => {
  const { calls } = await run({ message: '```json\n' + msg([]) + '\n```' });
  assert.match(calls[0].body, /未发现问题/);
});

test('truncates oversized bodies', async () => {
  const { calls } = await run({ message: msg([finding({ body: 'x'.repeat(70000), start_line: 99, end_line: 99 })]) });
  assert.ok(calls[0].body.length <= 60000 + 20);
  assert.match(calls[0].body, /已截断/);
});

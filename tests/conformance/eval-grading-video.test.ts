/**
 * The optional recording of a grade (`grade --video`). The recording pass opens the served page once
 * more in a recording browser and keeps the one video it wrote as `probe.webm` beside the probe's
 * evidence: the measuring probe's own files are left alone, a pass that recorded nothing keeps
 * nothing, and whatever else a recorder leaves in its scratch folder is never moved into evidence.
 * A grade asked for video records each stop-time snapshot that drew, after its probe, and carries the
 * path in its grade record; a grade not asked records nothing. The fakes stand in for the recording
 * browser; real Chromium is `eval-prober-browser.test.ts` (opt-in).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { FINAL_EVIDENCE_DIR, gradeCampaign, gradeDirOf, readGradeRecord } from "../../scripts/evals/grade/pipeline.ts";
import { recordProbeVideo, VIDEO_FILE } from "../../scripts/evals/grade/video-pass.ts";
import type { ProbeBrowser } from "../../scripts/evals/prober/driver.ts";
import { probeLockPath } from "../../scripts/evals/prober/lock.ts";
import { RendererMode } from "../../scripts/evals/vocabulary.ts";
import { CAMPAIGN, harness, LANES, runIdOf, seedCampaign, writeSnapshots } from "../fixtures/evals/grading/campaign.ts";
import { tmpDir } from "../helpers/tmp.ts";

const URL_ = "http://127.0.0.1:4173/index.html";
const SCORECARD = "full-probe.json";
const SCORECARD_TEXT = '{"measured":true}\n';

async function setup() {
  const home = fs.realpathSync(await tmpDir("eval-grading-video-"));
  const evidenceDir = path.join(home, "evidence", "run-1", "grade-2", FINAL_EVIDENCE_DIR);
  await mkdir(evidenceDir, { recursive: true });
  // What the measuring probe wrote before the recording pass ran.
  await writeFile(path.join(evidenceDir, SCORECARD), SCORECARD_TEXT);
  return { home, evidenceDir, lockPath: probeLockPath({ GENEX_EVALS_HOME: home }) };
}

/** A recording browser stand-in: its page never opens, and closing it leaves `leave(dir)` behind. */
function recordingBrowser(dir: string, leave: (dir: string) => Promise<void>): ProbeBrowser {
  return {
    open: async () => {
      throw new Error("the fake has no page");
    },
    close: () => leave(dir),
  };
}

const options = (evidenceDir: string) => ({ rendererMode: RendererMode.Software, evidenceDir });

describe("the recording pass", () => {
  it("keeps the video the recording browser wrote as probe.webm and leaves the probe's files alone", async () => {
    const { evidenceDir, lockPath } = await setup();
    const launched: Array<{ mode: RendererMode; dir: string }> = [];
    const video = await recordProbeVideo(URL_, options(evidenceDir), {
      lockPath,
      launch: async (mode, dir) => {
        launched.push({ mode, dir });
        return recordingBrowser(dir, (to) => writeFile(path.join(to, "page-1.webm"), "recorded"));
      },
    });

    assert.equal(video, path.join(evidenceDir, VIDEO_FILE));
    assert.equal(fs.readFileSync(path.join(evidenceDir, VIDEO_FILE), "utf8"), "recorded");
    assert.equal(launched.length, 1, "one recording browser");
    assert.equal(launched[0]?.mode, RendererMode.Software);
    assert.deepEqual((await readdir(evidenceDir)).sort(), [SCORECARD, VIDEO_FILE].sort(), "the scratch folder is gone");
    assert.equal(fs.readFileSync(path.join(evidenceDir, SCORECARD), "utf8"), SCORECARD_TEXT);
    assert.equal(fs.existsSync(lockPath), false, "the lock is released");
  });

  it("keeps the longest recording when the page opened another one", async () => {
    const { evidenceDir, lockPath } = await setup();
    const video = await recordProbeVideo(URL_, options(evidenceDir), {
      lockPath,
      launch: async (_mode, dir) =>
        recordingBrowser(dir, async (to) => {
          await writeFile(path.join(to, "popup.webm"), "x");
          await writeFile(path.join(to, "game.webm"), "the whole pass");
        }),
    });

    assert.equal(video, path.join(evidenceDir, VIDEO_FILE));
    assert.equal(fs.readFileSync(path.join(evidenceDir, VIDEO_FILE), "utf8"), "the whole pass");
  });

  it("answers null, never throws, when the browser cannot be launched", async () => {
    const { evidenceDir, lockPath } = await setup();
    const video = await recordProbeVideo(URL_, options(evidenceDir), {
      lockPath,
      launch: async () => {
        throw new Error("no browser on this machine");
      },
    });

    assert.equal(video, null);
    assert.deepEqual(await readdir(evidenceDir), [SCORECARD]);
  });

  /** What a recorder may leave in the scratch folder that is not a recording: none of it reaches evidence. */
  const LEFT_BEHIND: Array<{ name: string; leave: (dir: string, outside: string) => Promise<void> }> = [
    { name: "nothing at all", leave: async () => {} },
    { name: "a file that is not a video", leave: (dir) => writeFile(path.join(dir, "trace.zip"), "zip") },
    { name: "an empty video", leave: (dir) => writeFile(path.join(dir, "page-1.webm"), "") },
    { name: "a folder named like a video", leave: async (dir) => void (await mkdir(path.join(dir, "page-1.webm"))) },
    {
      name: "a link to a file outside the evidence folder",
      leave: (dir, outside) => symlink(outside, path.join(dir, "page-1.webm")),
    },
    {
      name: "a link to a video-sized file beside a real folder",
      leave: async (dir, outside) => {
        await mkdir(path.join(dir, "a.webm"));
        await symlink(outside, path.join(dir, "b.webm"));
      },
    },
  ];

  for (const row of LEFT_BEHIND) {
    it(`keeps no video and moves nothing when the recorder left ${row.name}`, async () => {
      const { home, evidenceDir, lockPath } = await setup();
      const outside = path.join(home, "outside.webm");
      await writeFile(outside, "not this run's evidence");
      const video = await recordProbeVideo(URL_, options(evidenceDir), {
        lockPath,
        launch: async (_mode, dir) => recordingBrowser(dir, (to) => row.leave(to, outside)),
      });

      assert.equal(video, null);
      assert.deepEqual(await readdir(evidenceDir), [SCORECARD], "nothing is added to the evidence folder");
      assert.equal(fs.readFileSync(outside, "utf8"), "not this run's evidence", "the outside file is untouched");
    });
  }
});

describe("a grade that records video", () => {
  it("records each stop-time snapshot once, on the page its probe saw, and keeps the path in the grade record", async () => {
    const recorded: Array<{ url: string; evidenceDir: string; rendererMode: RendererMode }> = [];
    const h = await harness({
      recordVideo: async (url, { evidenceDir, rendererMode }) => {
        recorded.push({ url, evidenceDir, rendererMode });
        const file = path.join(evidenceDir, VIDEO_FILE);
        await writeFile(file, "recorded");
        return file;
      },
    });
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);

    assert.equal(report.graded.length, 4);
    const finalProbes = h.log.probed.filter((probe) => probe.options.evidenceDir.endsWith(`${path.sep}final`));
    assert.deepEqual(
      recorded.map(({ url, evidenceDir }) => ({ url, evidenceDir })),
      finalProbes.map(({ url, options }) => ({ url, evidenceDir: options.evidenceDir })),
      "one recording per final probe, of the same served page, into the same evidence folder",
    );
    assert.ok(recorded.every(({ rendererMode }) => rendererMode === h.deps.rendererMode));
    const runId = runIdOf(LANES.a);
    const record = await readGradeRecord(h.deps.paths, runId, 2);
    assert.equal(
      record?.probe?.evidence.videoPath,
      path.join(gradeDirOf(h.deps.paths, runId, 2), FINAL_EVIDENCE_DIR, VIDEO_FILE),
    );
  });

  it("keeps no video unless asked", async () => {
    const h = await harness();
    await seedCampaign(h);
    await gradeCampaign(CAMPAIGN, h.deps);

    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2);
    assert.ok(record?.probe, "the run was probed");
    assert.equal(record.probe.evidence.videoPath, null);
  });

  it("never records a page that did not draw", async () => {
    const recorded: string[] = [];
    const h = await harness({
      recordVideo: async (url) => {
        recorded.push(url);
        return null;
      },
    });
    const rows = await seedCampaign(h);
    for (const row of rows) {
      await writeSnapshots(h.deps.paths, row.runId, [{ atMs: 60_000, boots: false, playable: false, final: true }]);
    }
    await gradeCampaign(CAMPAIGN, h.deps);

    assert.deepEqual(recorded, []);
    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2);
    assert.ok(record?.probe, "the run was probed");
    assert.equal(record.probe.evidence.videoPath, null);
  });

  it("grades as before when the recording fails", async () => {
    const h = await harness({
      recordVideo: async () => {
        throw new Error("the recorder crashed");
      },
    });
    await seedCampaign(h);
    const report = await gradeCampaign(CAMPAIGN, h.deps);

    assert.equal(report.graded.length, 4);
    const record = await readGradeRecord(h.deps.paths, runIdOf(LANES.a), 2);
    assert.ok(record?.probe, "the probe is kept");
    assert.equal(record.probe.evidence.videoPath, null);
  });
});

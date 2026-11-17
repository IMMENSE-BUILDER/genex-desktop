/**
 * The recording pass of a grade (`grade --video`). The served page is opened once more, in a browser
 * that records it, and taken through the quick probe's phases (boot, entrance, input bursts). It is a
 * pass of its own because a recorder loads the page: the probe that measures frame rate and timing
 * never runs under one, so a grade's rows are the same with and without video. The pass's own rows
 * and frames are thrown away; only the video is kept, as `probe.webm` in the evidence folder.
 */
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ProbeBrowser } from "../prober/driver.ts";
import { launchPlaywright } from "../prober/playwright-driver.ts";
import type { RendererMode } from "../vocabulary.ts";
import { QUICK_FIRST_DRAW_TIMEOUT_MS, runQuickProbe } from "./quick-probe.ts";
import type { VideoPassOptions } from "./types.ts";

/** The kept video's file name inside a grade's evidence folder. */
export const VIDEO_FILE = "probe.webm";
/** The scratch folder the browser records into; it lives in the evidence folder so the move never crosses a volume. */
const SCRATCH_PREFIX = "video-";
/** Where the pass's own probe writes the frames and scorecard nobody reads. */
const SCRATCH_PROBE_DIR = "probe";
const VIDEO_EXTENSION = ".webm";
/** The pass ends with the input bursts: it waits for no error window. */
const NO_ERROR_WINDOW_MS = 0;

/** What the recording pass runs on; tests replace the browser and the lock. */
export interface VideoPassDeps {
  /** Launch a browser that records its desktop page into `dir`; defaults to Playwright. */
  launch?: (mode: RendererMode, dir: string) => Promise<ProbeBrowser>;
  /** The machine-wide probe lock's path; defaults to the one under `$GENEX_EVALS_HOME`. */
  lockPath?: string;
}

/** The largest non-empty regular `.webm` file in `dir`: a link or a folder is never a recording. */
async function recordingIn(dir: string): Promise<string | null> {
  let best: { file: string; size: number } | null = null;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(VIDEO_EXTENSION)) continue;
    const file = path.join(dir, name);
    const stat = await lstat(file);
    if (stat.isFile() && stat.size > (best?.size ?? 0)) best = { file, size: stat.size };
  }
  return best?.file ?? null;
}

/** Take the page through the quick probe's phases in a browser recording into `scratch`. */
async function playRecorded(url: string, options: VideoPassOptions, deps: VideoPassDeps, scratch: string) {
  const launch = deps.launch ?? ((mode: RendererMode, dir: string) => launchPlaywright(mode, undefined, { dir }));
  const evidenceDir = path.join(scratch, SCRATCH_PROBE_DIR);
  await mkdir(evidenceDir);
  await runQuickProbe(
    url,
    {
      firstDrawTimeoutMs: QUICK_FIRST_DRAW_TIMEOUT_MS,
      noErrorsMs: NO_ERROR_WINDOW_MS,
      rendererMode: options.rendererMode,
      evidenceDir,
    },
    { launch: (mode) => launch(mode, scratch), lockPath: deps.lockPath },
  );
}

/**
 * Record `url` being entered and played (`RecordProbeVideo`): the path of the kept video, or null
 * when the browser wrote none. It never throws: a failed recording must not cost the grade.
 */
export async function recordProbeVideo(
  url: string,
  options: VideoPassOptions,
  deps: VideoPassDeps = {},
): Promise<string | null> {
  const scratch = await mkdtemp(path.join(options.evidenceDir, SCRATCH_PREFIX)).catch(() => null);
  if (scratch === null) return null;
  try {
    // A page that crashed halfway still leaves the part that was recorded, so the probe's failure is not the pass's.
    await playRecorded(url, options, deps, scratch).catch(() => {});
    const recorded = await recordingIn(scratch);
    if (recorded === null) return null;
    const kept = path.join(options.evidenceDir, VIDEO_FILE);
    await rename(recorded, kept);
    return kept;
  } catch {
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

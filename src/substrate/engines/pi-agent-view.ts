/**
 * macOS and Linux: the folder a session's Pi is pointed at in place of the person's own.
 *
 * Pi makes a lock folder beside `auth.json` even to read it, saves a renewed sign-in into that
 * file, and keeps a lock and a cache beside its model store: a session must write where they are.
 * What Pi keeps in its folder it also loads and runs outside the sandbox, for the person and for
 * Genex's own model listing: an extension, `models.json`, `APPEND_SYSTEM.md`, and the sign-in
 * itself, where a stored key that starts with `!` is a command. Linux's sandbox grants a folder
 * whole and cannot keep a session from making an entry that is not there yet; macOS can name the
 * locks, but the sign-in a session saves is still the file the person's Pi runs. So a session
 * gets a folder of its own, `<agent>/genex/agent`, which stands for the person's:
 *
 * - `auth.json` and `models-store.json` (Pi's cache of its providers' catalogs) are copies made new
 *   for each session. Nothing is copied back: a sign-in renewed in a session lasts that session.
 * - every other entry is a link to the person's, which a session reads and cannot write.
 *   `sessions` is granted, so transcripts stay where Pi keeps them.
 *
 * The person's own Pi never reads this folder, and what a session left in it is put right before
 * the next one starts. Beside it `<agent>/genex/work`, which no session writes, holds what is on
 * its way in (made whole there, then renamed into place) and on its way out (renamed there, then
 * removed), so nothing is written or removed through a name a running session can change.
 * Read from Pi 1.5.2 (`dist/core/auth-storage.js`, `dist/core/models-store.js`,
 * `dist/core/resolve-config-value.js`) and proper-lockfile 4.1.2 (`realpath` on by default).
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { PI_SESSIONS_DIR } from "./pi-sessions.ts";

/** Genex's own folder inside Pi's folder: the session folder and the work folder beside it. */
const OWN_DIR = "genex";
const VIEW_DIR = "agent";
const WORK_DIR = "work";
const SIGN_IN = "auth.json";
const MODEL_STORE = "models-store.json";
/** proper-lockfile's lock folders: `<file>.lock`, made and removed while a session runs. */
const LOCK_SUFFIX = ".lock";
/** Pi's own mode for its folder and its sign-in file. */
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const EMPTY_STORE = "{}";
/** A build takes milliseconds: what sits in the work folder longer was left by one that never ended. */
const WORK_LEFT_BEHIND_MS = MINUTE_MS;

/** The session folder of Pi's folder `agent`, whether or not it is there yet. */
export function piViewDir(agent: string): string {
  return path.join(agent, OWN_DIR, VIEW_DIR);
}

/** One build at a time: two sessions starting together would each replace what the other just made. */
let building: Promise<unknown> = Promise.resolve();

/**
 * Makes the session folder of Pi's folder `agent` stand for it as it is now, and returns it by
 * its real path. Every write is to an entry of the folder itself, never through one: a session
 * can leave a link there, and following it would write outside the folder as the person.
 */
export function preparePiView(agent: string, now: () => number = Date.now): Promise<string> {
  const built = building.then(() => buildView(agent, now));
  building = built.catch(() => {});
  return built;
}

async function buildView(agent: string, now: () => number): Promise<string> {
  await mkdir(path.join(agent, PI_SESSIONS_DIR), { recursive: true, mode: OWNER_ONLY_DIR });
  const real = await realpath(agent);
  const view = piViewDir(real);
  const work = path.join(real, OWN_DIR, WORK_DIR);
  await mkdir(view, { recursive: true, mode: OWNER_ONLY_DIR });
  await mkdir(work, { recursive: true, mode: OWNER_ONLY_DIR });
  await sweepWork(work, now());
  const mirrored = (await readdir(real)).filter(isMirrored);
  for (const name of mirrored) await pointAt(path.join(view, name), path.join(real, name), work);
  // No sign-in file: none in the session's folder either. No model store: an empty one, which Pi fills.
  await copyAs(path.join(real, SIGN_IN), path.join(view, SIGN_IN), work, null);
  await copyAs(path.join(real, MODEL_STORE), path.join(view, MODEL_STORE), work, EMPTY_STORE);
  const kept = new Set([...mirrored, SIGN_IN, MODEL_STORE]);
  for (const name of await readdir(view)) {
    const entry = path.join(view, name);
    const isKept = kept.has(name) || (await isLockFolder(entry));
    if (!isKept) await discard(entry, work);
  }
  return view;
}

/** A name in the work folder nobody else has: another Genex on this computer may be building too. */
function workName(work: string): string {
  return path.join(work, randomUUID());
}

/** Removes what a build that never ended left in the work folder; a build that runs now keeps its own. */
async function sweepWork(work: string, at: number): Promise<void> {
  for (const name of await readdir(work)) {
    const left = path.join(work, name);
    const made = await lstat(left).catch(() => null);
    const isLeftBehind = made !== null && at - made.mtimeMs > WORK_LEFT_BEHIND_MS;
    // What cannot be removed now is tried again by the next build.
    if (isLeftBehind) await rm(left, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Takes `entry` out of the session folder: renamed into the work folder, where no session reaches
 * it, and removed there. A rename moves the name itself, whatever a session made of it.
 */
async function discard(entry: string, work: string): Promise<void> {
  const out = workName(work);
  const moved = await rename(entry, out).then(
    () => true,
    () => false,
  );
  // What cannot be removed now waits in the work folder for the next build's sweep.
  if (moved) await rm(out, { recursive: true, force: true }).catch(() => {});
}

/** Puts `made`, a whole entry in the work folder, in `entry`'s place, whatever a session left there. */
async function place(made: string, entry: string, work: string): Promise<void> {
  const inPlace = await rename(made, entry).then(
    () => true,
    () => false,
  );
  if (inPlace) return;
  // A folder under the name: a rename replaces a file or a link, never a folder.
  await discard(entry, work);
  await rename(made, entry);
}

/**
 * A lock as proper-lockfile makes one, which another session may hold now: an empty folder named
 * `<file>.lock`. Anything else under such a name would keep every later session from its lock.
 */
async function isLockFolder(entry: string): Promise<boolean> {
  if (!entry.endsWith(LOCK_SUFFIX)) return false;
  const now = await lstat(entry).catch(() => null);
  if (!now?.isDirectory()) return false;
  return (await readdir(entry)).length === 0;
}

/** An entry of Pi's folder a session reads through a link: all but the two it gets a copy of and Genex's own folder. */
function isMirrored(name: string): boolean {
  if (name === OWN_DIR || name === SIGN_IN || name === MODEL_STORE) return false;
  return !name.endsWith(LOCK_SUFFIX);
}

/** Makes `entry` a link to `target`, whatever a session left under that name. */
async function pointAt(entry: string, target: string, work: string): Promise<void> {
  const now = await readlink(entry).catch(() => null);
  if (now === target) return;
  const made = workName(work);
  await symlink(target, made);
  await place(made, entry, work);
}

/**
 * Makes `entry` a copy of `source` as it is now, the owner's alone, whatever a session left under
 * the name. The bytes are copied and never read as anything else. Where `source` cannot be read,
 * `entry` holds `missing`, or is taken away when there is none.
 */
async function copyAs(source: string, entry: string, work: string, missing: string | null): Promise<void> {
  const content = await readFile(source).catch(() => missing);
  if (content === null) return discard(entry, work);
  const made = workName(work);
  // A name no session can reach, and never an existing entry: `wx` follows no link.
  await writeFile(made, content, { flag: "wx", mode: OWNER_ONLY_FILE });
  await place(made, entry, work);
}

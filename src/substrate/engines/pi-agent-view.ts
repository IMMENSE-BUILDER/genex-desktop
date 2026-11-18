/**
 * Linux: the folder a session's Pi is pointed at in place of the person's own.
 *
 * Pi makes a lock folder beside `auth.json` even to read it, and one beside its model store, so a
 * session must be able to make entries in the folder that holds them. Linux's sandbox grants a
 * folder whole or not at all, and cannot keep a session from making an entry that is not there
 * yet: a grant on the person's own folder would let a session plant what Pi later loads and runs
 * outside the sandbox (an extension, `models.json`, `APPEND_SYSTEM.md`). So a session there gets
 * a folder of its own, `<agent>/genex`, which stands for the person's:
 *
 * - `auth.json` is the person's own file under a second name (a hard link). Pi locks the path the
 *   name resolves to, which is this one, and saves a renewed sign-in into the one file.
 * - `models-store.json`, Pi's cache of its providers' catalogs, is a copy made new for each session.
 * - every other entry is a link to the person's, which a session reads and cannot write.
 *   `sessions` is granted, so transcripts stay where Pi keeps them.
 *
 * The person's own Pi never reads this folder, and what a session left in it is put right before
 * the next one starts. Read from Pi 1.5.2 (`dist/core/auth-storage.js`, `dist/core/models-store.js`)
 * and proper-lockfile 4.1.2 (`realpath` on by default).
 */
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** The session folder's name inside Pi's folder. */
const VIEW_DIR = "genex";
const SIGN_IN = "auth.json";
const MODEL_STORE = "models-store.json";
const SESSIONS = "sessions";
/** proper-lockfile's lock folders: `<file>.lock`, made and removed while a session runs. */
const LOCK_SUFFIX = ".lock";
/** Pi's own mode for its folder and its sign-in file. */
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const EMPTY_STORE = "{}";

const MESSAGE = {
  SignInElsewhere:
    "Pi's sign-in file is on another disk than Pi's folder, so a session on Linux cannot share it. Keep auth.json in Pi's folder itself.",
} as const;

/** The session folder of Pi's folder `agent`, whether or not it is there yet. */
export function piViewDir(agent: string): string {
  return path.join(agent, VIEW_DIR);
}

/** One build at a time: two sessions starting together would each remove what the other just made. */
let building: Promise<unknown> = Promise.resolve();

/**
 * Makes the session folder of Pi's folder `agent` stand for it as it is now, and returns it by
 * its real path. Every write is to an entry of the folder itself, never through one: a session
 * can leave a link there, and following it would write outside the folder as the person.
 */
export function preparePiView(agent: string): Promise<string> {
  const built = building.then(() => buildView(agent));
  building = built.catch(() => {});
  return built;
}

async function buildView(agent: string): Promise<string> {
  await mkdir(path.join(agent, SESSIONS), { recursive: true, mode: OWNER_ONLY_DIR });
  const real = await realpath(agent);
  const view = piViewDir(real);
  await mkdir(view, { recursive: true, mode: OWNER_ONLY_DIR });
  const mirrored = (await readdir(real)).filter(isMirrored);
  for (const name of mirrored) await pointAt(path.join(view, name), path.join(real, name));
  await shareSignIn(path.join(real, SIGN_IN), path.join(view, SIGN_IN));
  await renewStore(path.join(real, MODEL_STORE), path.join(view, MODEL_STORE));
  const kept = new Set([...mirrored, SIGN_IN, MODEL_STORE]);
  for (const name of await readdir(view)) {
    const entry = path.join(view, name);
    const isKept = kept.has(name) || (await isLockFolder(entry));
    if (!isKept) await rm(entry, { recursive: true, force: true });
  }
  return view;
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

/** An entry of Pi's folder a session reads through a link: all but the three it writes and the folder itself. */
function isMirrored(name: string): boolean {
  if (name === VIEW_DIR || name === SIGN_IN || name === MODEL_STORE) return false;
  return !name.endsWith(LOCK_SUFFIX);
}

/** Makes `entry` a link to `target`, whatever a session left under that name. */
async function pointAt(entry: string, target: string): Promise<void> {
  const now = await readlink(entry).catch(() => null);
  if (now === target) return;
  await rm(entry, { recursive: true, force: true });
  await symlink(target, entry);
}

/** Makes `entry` the person's sign-in file itself, under a second name; no entry while there is no sign-in. */
async function shareSignIn(file: string, entry: string): Promise<void> {
  const source = await realpath(file).catch(() => null);
  const [own, shared] = await Promise.all([source ? stat(source) : null, lstat(entry).catch(() => null)]);
  const isSameFile = own !== null && shared?.isFile() === true && shared.ino === own.ino && shared.dev === own.dev;
  if (isSameFile) return;
  await rm(entry, { recursive: true, force: true });
  if (!source) return;
  await link(source, entry).catch((cause: unknown) => {
    throw new Error(MESSAGE.SignInElsewhere, { cause });
  });
}

/** Replaces `entry` with a copy of the person's model store as it is now, or an empty one. */
async function renewStore(source: string, entry: string): Promise<void> {
  const content = await readFile(source, "utf8").catch(() => EMPTY_STORE);
  const fresh = `${entry}.${randomUUID()}`;
  // A name no session can have guessed, and never an existing entry: `wx` follows no link.
  await writeFile(fresh, content, { flag: "wx", mode: OWNER_ONLY_FILE });
  const now = await lstat(entry).catch(() => null);
  if (now && !now.isFile()) await rm(entry, { recursive: true, force: true });
  await rename(fresh, entry);
}

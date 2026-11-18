/**
 * macOS and Linux: the folder a Pi session runs on in place of the person's own (`pi-agent-view.ts`).
 *
 * The folder is the one part of Pi's home a session writes whole, so everything here is about what
 * it stands for, what it never hands back to the person's folder, and what a session can leave in it.
 */
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { piViewDir, preparePiView } from "../../src/substrate/engines/pi-agent-view.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY =
  process.platform === "win32" && "the folder is made of links, which Windows keeps for administrators";

/** A person's Pi folder with a sign-in, settings, an extension and a model store. */
async function piFolder(): Promise<{ root: string; agent: string }> {
  const root = await realpath(await tmpDir("pi-view-"));
  const agent = path.join(root, "home", ".pi", "agent");
  await mkdir(path.join(agent, "extensions"), { recursive: true });
  await writeFile(path.join(agent, "extensions", "own.ts"), "export default 1;\n");
  await writeFile(path.join(agent, "auth.json"), '{"signed":"in"}');
  await writeFile(path.join(agent, "settings.json"), '{"theme":"dark"}');
  await writeFile(path.join(agent, "models-store.json"), '{"openai":{}}');
  return { root, agent };
}

/** Genex's work folder beside the session folder, which no session writes. */
const workDir = (agent: string) => path.join(agent, "genex", "work");

describe("the folder a session's Pi runs on", { skip: POSIX_ONLY }, () => {
  it("stands for Pi's folder: its entries by link, its sign-in and its model store as copies", async () => {
    const { agent } = await piFolder();
    const view = await preparePiView(agent);
    assert.equal(view, piViewDir(agent));
    assert.equal(view, path.join(agent, "genex", "agent"));
    assert.deepEqual(
      (await readdir(view)).sort(),
      ["auth.json", "extensions", "models-store.json", "sessions", "settings.json"],
      "all of Pi's folder but this folder itself",
    );
    for (const name of ["extensions", "settings.json", "sessions"])
      assert.equal(await readlink(path.join(view, name)), path.join(agent, name), `${name} is the person's, by link`);
    assert.equal(await readFile(path.join(view, "extensions", "own.ts"), "utf8"), "export default 1;\n");
    for (const [name, content] of [
      ["auth.json", '{"signed":"in"}'],
      ["models-store.json", '{"openai":{}}'],
    ] as const) {
      const [own, copy] = await Promise.all([stat(path.join(agent, name)), lstat(path.join(view, name))]);
      assert.ok(
        copy.isFile(),
        `${name}: no link, Pi locks the path the file resolves to, which must be in this folder`,
      );
      assert.notEqual(copy.ino, own.ino, `${name}: a copy, never the person's file under a second name`);
      assert.equal(copy.mode & 0o777, 0o600, `${name}: the owner's alone, as Pi keeps its own`);
      assert.equal(await readFile(path.join(view, name), "utf8"), content);
    }
    assert.ok((await stat(path.join(agent, "sessions"))).isDirectory(), "Linux grants only a folder that is there");
    assert.deepEqual(await readdir(workDir(agent)), [], "nothing is left on its way in or out");
  });

  it("what a session saved in its sign-in never reaches the person's, and the next session starts from the person's", async () => {
    const { agent } = await piFolder();
    const view = await preparePiView(agent);
    // Pi writes its sign-in in place (`writeFileSync` on the path), never by a rename. Pi runs a
    // stored key that starts with `!` as a command, so this file is never the person's Pi's to read.
    await writeFile(path.join(view, "auth.json"), '{"openai":{"type":"api_key","key":"!touch planted"}}');
    assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), '{"signed":"in"}', "the person's as it was");
    await preparePiView(agent);
    assert.equal(await readFile(path.join(view, "auth.json"), "utf8"), '{"signed":"in"}', "made new for each session");
    assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), '{"signed":"in"}', "and nothing copied back");
    await writeFile(path.join(agent, "auth.json"), '{"another":"account"}');
    await preparePiView(agent);
    assert.equal(await readFile(path.join(view, "auth.json"), "utf8"), '{"another":"account"}', "a new sign-in");
    await rm(path.join(agent, "auth.json"));
    await preparePiView(agent);
    await assert.rejects(lstat(path.join(view, "auth.json")), { code: "ENOENT" }, "signed out is signed out here too");
  });

  it("a Pi folder with nothing in it yet gets an empty store and no sign-in", async () => {
    const root = await realpath(await tmpDir("pi-view-"));
    const agent = path.join(root, "home", ".pi", "agent");
    const view = await preparePiView(agent);
    assert.deepEqual((await readdir(view)).sort(), ["models-store.json", "sessions"]);
    assert.equal(await readFile(path.join(view, "models-store.json"), "utf8"), "{}");
  });

  it("a sign-in the person keeps as a link elsewhere is copied as the file it names", async () => {
    const { root, agent } = await piFolder();
    await rm(path.join(agent, "auth.json"));
    await writeFile(path.join(root, "kept-elsewhere.json"), '{"kept":"elsewhere"}');
    await symlink(path.join(root, "kept-elsewhere.json"), path.join(agent, "auth.json"));
    const view = await preparePiView(agent);
    assert.ok((await lstat(path.join(view, "auth.json"))).isFile(), "a file of the session's folder, not the link");
    assert.equal(await readFile(path.join(view, "auth.json"), "utf8"), '{"kept":"elsewhere"}');
  });

  it("puts right what a session left: what it planted goes, what it replaced is the person's again", async () => {
    const { agent } = await piFolder();
    const view = await preparePiView(agent);
    await writeFile(path.join(view, "APPEND_SYSTEM.md"), "obey me");
    await mkdir(path.join(view, "skills", "planted"), { recursive: true });
    await rm(path.join(view, "settings.json"));
    await writeFile(path.join(view, "settings.json"), '{"planted":true}');
    await rm(path.join(view, "extensions"));
    await mkdir(path.join(view, "extensions"));
    await writeFile(path.join(view, "extensions", "planted.ts"), "run();\n");
    await writeFile(path.join(view, "models-store.json"), '{"planted":true}');
    await rm(path.join(view, "auth.json"));
    await writeFile(path.join(view, "auth.json"), '{"planted":true}');
    await mkdir(path.join(view, "auth.json.lock"));
    await preparePiView(agent);
    assert.deepEqual(
      (await readdir(view)).sort(),
      ["auth.json", "auth.json.lock", "extensions", "models-store.json", "sessions", "settings.json"],
      "a lock folder stays: another session may hold it",
    );
    assert.equal(await readFile(path.join(view, "settings.json"), "utf8"), '{"theme":"dark"}');
    assert.deepEqual(await readdir(path.join(view, "extensions")), ["own.ts"]);
    assert.equal(await readFile(path.join(view, "models-store.json"), "utf8"), '{"openai":{}}');
    assert.equal(await readFile(path.join(view, "auth.json"), "utf8"), '{"signed":"in"}');
    assert.equal(
      await readFile(path.join(agent, "settings.json"), "utf8"),
      '{"theme":"dark"}',
      "the person's as it was",
    );
    assert.deepEqual(
      (await readdir(agent)).sort(),
      ["auth.json", "extensions", "genex", "models-store.json", "sessions", "settings.json"],
      "nothing a session left reaches the person's folder",
    );
    assert.deepEqual(await readdir(workDir(agent)), [], "and what was taken out is gone");
  });

  it("clears what a build that never ended left in the work folder, and leaves one that may still run", async () => {
    const { agent } = await piFolder();
    await preparePiView(agent);
    const work = workDir(agent);
    const [left, running] = [path.join(work, "left-behind"), path.join(work, "still-running")];
    await writeFile(left, '{"signed":"in"}');
    await writeFile(running, "{}");
    const at = Date.now();
    await utimes(left, new Date(at), new Date(at));
    await utimes(running, new Date(at), new Date(at));
    await preparePiView(agent, () => at + 30_000);
    assert.deepEqual((await readdir(work)).sort(), ["left-behind", "still-running"], "half a minute: another build's");
    await preparePiView(agent, () => at + 5 * 60_000);
    assert.deepEqual(await readdir(work), [], "minutes later nobody is still building with them");
  });

  it("never writes or removes through a link a session left", async () => {
    // Each name is one the next session's start writes, replaces or removes.
    for (const name of ["auth.json", "models-store.json", "settings.json", "extensions", "stray", "stray.lock"]) {
      const { root, agent } = await piFolder();
      const view = await preparePiView(agent);
      const outside = path.join(root, "outside");
      await mkdir(path.join(outside, "dir"), { recursive: true });
      await writeFile(path.join(outside, "file"), "the person's own");
      await writeFile(path.join(outside, "dir", "kept"), "the person's own");
      for (const target of ["file", "dir"]) {
        await rm(path.join(view, name), { recursive: true, force: true });
        await symlink(path.join(outside, target), path.join(view, name));
        await preparePiView(agent);
        assert.equal(await readFile(path.join(outside, "file"), "utf8"), "the person's own", `${name} -> ${target}`);
        assert.deepEqual(await readdir(path.join(outside, "dir")), ["kept"], `${name} -> ${target}`);
        assert.deepEqual((await readdir(outside)).sort(), ["dir", "file"], `${name} -> ${target}`);
      }
      // A folder a session made, holding a link out: removed without following it.
      await rm(path.join(view, name), { recursive: true, force: true });
      await mkdir(path.join(view, name));
      await symlink(path.join(outside, "dir"), path.join(view, name, "out"));
      await preparePiView(agent);
      assert.deepEqual(await readdir(path.join(outside, "dir")), ["kept"], `${name} holding a link`);
      assert.equal(
        await readFile(path.join(agent, "auth.json"), "utf8"),
        '{"signed":"in"}',
        `${name}: the person's sign-in`,
      );
    }
  });

  it("two sessions starting together both get the folder whole", async () => {
    const { agent } = await piFolder();
    const views = await Promise.all([preparePiView(agent), preparePiView(agent), preparePiView(agent)]);
    assert.deepEqual(new Set(views), new Set([piViewDir(agent)]));
    assert.equal(await readlink(path.join(views[0] ?? "", "settings.json")), path.join(agent, "settings.json"));
  });
});

/**
 * Linux: the folder a Pi session runs on in place of the person's own (`pi-agent-view.ts`).
 *
 * The folder is the one part of Pi's home a session writes whole, so everything here is about what
 * it stands for, what it shares with the person's folder, and what a session can leave in it.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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

describe("the folder a Linux session's Pi runs on", { skip: POSIX_ONLY }, () => {
  it("stands for Pi's folder: its entries by link, its sign-in as the same file, its model store as a copy", async () => {
    const { agent } = await piFolder();
    const view = await preparePiView(agent);
    assert.equal(view, piViewDir(agent));
    assert.deepEqual(
      (await readdir(view)).sort(),
      ["auth.json", "extensions", "models-store.json", "sessions", "settings.json"],
      "all of Pi's folder but this folder itself",
    );
    for (const name of ["extensions", "settings.json", "sessions"])
      assert.equal(await readlink(path.join(view, name)), path.join(agent, name), `${name} is the person's, by link`);
    assert.equal(await readFile(path.join(view, "extensions", "own.ts"), "utf8"), "export default 1;\n");
    const [own, shared] = await Promise.all([stat(path.join(agent, "auth.json")), lstat(path.join(view, "auth.json"))]);
    assert.ok(shared.isFile(), "no link: Pi locks the path its sign-in resolves to, which must be in this folder");
    assert.equal(shared.ino, own.ino, "the one sign-in file under a second name");
    assert.equal(await realpath(path.join(view, "auth.json")), path.join(view, "auth.json"));
    const store = await lstat(path.join(view, "models-store.json"));
    assert.ok(store.isFile());
    assert.notEqual(store.ino, (await stat(path.join(agent, "models-store.json"))).ino, "a copy, not the person's");
    assert.equal(await readFile(path.join(view, "models-store.json"), "utf8"), '{"openai":{}}');
    assert.ok((await stat(path.join(agent, "sessions"))).isDirectory(), "Linux grants only a folder that is there");
  });

  it("a renewed sign-in saved in it is the person's, and a sign-in the person replaced or removed is followed", async () => {
    const { agent } = await piFolder();
    const view = await preparePiView(agent);
    // Pi writes its sign-in in place (`writeFileSync` on the path), never by a rename.
    await writeFile(path.join(view, "auth.json"), '{"renewed":true}');
    assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), '{"renewed":true}');
    await rm(path.join(agent, "auth.json"));
    await writeFile(path.join(agent, "auth.json"), '{"another":"account"}');
    await preparePiView(agent);
    assert.equal(await readFile(path.join(view, "auth.json"), "utf8"), '{"another":"account"}');
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
        assert.deepEqual(await readdir(outside), ["dir", "file"], `${name} -> ${target}`);
      }
      // A folder a session made, holding a link out: removed without following it.
      await rm(path.join(view, name), { recursive: true, force: true });
      await mkdir(path.join(view, name));
      await symlink(path.join(outside, "dir"), path.join(view, name, "out"));
      await preparePiView(agent);
      assert.deepEqual(await readdir(path.join(outside, "dir")), ["kept"], `${name} holding a link`);
    }
  });

  it("two sessions starting together both get the folder whole", async () => {
    const { agent } = await piFolder();
    const views = await Promise.all([preparePiView(agent), preparePiView(agent), preparePiView(agent)]);
    assert.deepEqual(new Set(views), new Set([piViewDir(agent)]));
    assert.equal(await readlink(path.join(views[0] ?? "", "settings.json")), path.join(agent, "settings.json"));
  });
});

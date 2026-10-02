# Porting Pi plugins to Pi-Bolt

Pi plugins (Pi calls them *extensions*) work in Pi-Bolt without changes. Whether they run **fast** depends on how they are
loaded. This guide shows how to compile your plugins into the Pi-Bolt executable, so that they run as machine code like Pi itself,
and how to write plugin code that the ahead-of-time compiler handles well.

- [Short answer](#short-answer)
- [Three ways to run a plugin](#three-ways-to-run-a-plugin)
- [Compile plugins into the executable](#compile-plugins-into-the-executable)
- [Compatibility checklist](#compatibility-checklist)
- [Performance guide: code the AOT compiler handles well](#performance-guide)
- [Verify and measure](#verify-and-measure)
- [Troubleshooting](#troubleshooting)

## Short answer

**Is a plugin faster when it is compiled into the binary?** Yes. On the default (JIT off) build, a plugin loaded at run time from
`~/.pi/agent/extensions` is compiled from TypeScript by `jiti` at every start and then runs in JavaScriptCore's
**interpreter**. Compiled into the binary, it is bundled, type-stripped and compiled to machine code at build time, like the rest
of Pi.

Measured with the example plugin in [`examples/plugins`](../examples/plugins): a `/words` command that scans a 16.8 MB file
character by character. Pi 1.0.0, x86-64, medians of 7 sessions ([raw data](../bench/results/2026-10-02-pi-1.0.0)).

| How the plugin is loaded | Launch to ready | `/words` (hot loop) |
|---|---:|---:|
| **Compiled in**, Pi-Bolt (JIT off, the default) | **86 ms** | **54 ms** |
| Compiled in, Pi-Bolt JIT on | 83 ms | 53 ms |
| Loaded at run time (jiti), Pi-Bolt JIT off | 114 ms | 1,087 ms |
| Loaded at run time (jiti), Pi-Bolt JIT on | 122 ms | 41 ms |
| Loaded at run time (jiti), Bun 1.4.2 | 194 ms | 38 ms |
| *No plugin: Pi-Bolt / Bun* | *79 ms / 127 ms* | |

A compiled-in plugin:

- **Costs little at startup**: about 7 ms. Loading the same plugin with jiti costs 35 ms on Pi-Bolt and 67 ms on Bun.
- **Runs 20× faster than the interpreter** that run-time plugins get on the JIT-off build. The interpreter is why that row says
  1,087 ms: the JIT is off and run-time code was never compiled
  ([details](BENCHMARKS.md#why-is-a-run-time-plugins-loop-1080-ms-on-pi-bolt-and-38-ms-on-bun)).
- **Stays within 1.4× of fully warmed-up JIT code**, without the JIT's warm-up, compiler threads or memory.

## Three ways to run a plugin

| | Compiled in (`--plugins`) | Run-time loaded, JIT-off build | Run-time loaded, JIT-on build |
|---|---|---|---|
| Changes to the plugin | none (see the [checklist](#compatibility-checklist)) | none | none |
| Startup cost | none | jiti + TypeScript compile per start | jiti + TypeScript compile per start |
| Hot code runs as | AOT machine code | bytecode interpreter | interpreter, then JIT after warm-up |
| Memory | lowest | low | higher (JIT code and compiler threads) |
| Update the plugin | rebuild the executable (~10 s) | edit the file and restart | edit the file and restart |
| Best for | plugins you use every day | trying out a plugin, light plugins | many third-party plugins you cannot rebuild |

Run-time loading keeps working in every Pi-Bolt build: `~/.pi/agent/extensions`, project `.pi/extensions`, `pi --extension`, and
Pi packages installed with `pi install`. Compile in the plugins you rely on. Keep run-time loading for plugins you are developing
or trying out.

## Compile plugins into the executable

You need a Pi-Bolt build environment (see [BUILDING.md](BUILDING.md): `scripts/prepare-pi.sh` and either the release runtime or
`scripts/build-runtime.sh`).

### 1. Write a manifest

A manifest is a module whose default export is the list of plugins. Each entry is a plugin's factory (the default export of a Pi
extension), or `{ name, factory }` to give it a name in Pi's startup list and in error messages.

```ts
// my-plugins/plugins.ts
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import gitGuard from "./extensions/git-guard.ts";
import jiraTools from "./extensions/jira/index.ts";
import wordCount from "./extensions/word-count.ts";

const plugins: InlineExtension[] = [
	{ name: "git-guard", factory: gitGuard },
	{ name: "jira", factory: jiraTools },
	{ name: "word-count", factory: wordCount },
];

export default plugins;
```

Everything in the manifest's folder is built along with it, including a `node_modules/` folder for the plugins' own
dependencies (`npm install` there first). [`examples/plugins/plugins.ts`](../examples/plugins/plugins.ts) is a complete example.

### 2. Build

```bash
scripts/build-pi.sh --plugins my-plugins/plugins.ts --out out/pi-bolt-plugins
```

The script copies the manifest's folder into the Pi tree and generates an entry point. The entry starts Pi exactly as Pi's own
Bun entry does, passing your plugins to `main()` as `extensionFactories`. The script then compiles everything ahead of time, checks
that the executable uses its compiled code, and removes the staging folder. Options:

| Option | Use |
|---|---|
| `--plugin-worker PATH` | A worker script a plugin starts, relative to the manifest's folder ([how to start it](#compatibility-checklist)). Repeatable. |
| `--jit on` | Also JIT-compile what is loaded at run time (for run-time plugins you keep alongside). |
| `--profile DIR` | A training profile recorded with your plugins (step 4). |

### 3. Remove the run-time copies

If a compiled-in plugin also stays in `~/.pi/agent/extensions` (or is installed as a Pi package), Pi loads it twice and reports a
conflict for its tools and commands. Remove the run-time copy, or leave it out of your settings' `extensions` list.

### 4. Optional: train a profile with your plugins

The training profile is recorded during a scripted session: startup, a few prompts with tool calls, and some commands. It
records which functions run, so the executable can lay them out together, and which regular expressions are built from strings
at run time, so they can be compiled ahead of time. Code that only your plugin's own commands reach is not exercised by the
session. With plugins that do a lot at startup, record a profile of your own:

```bash
scripts/train-profile.sh --plugins my-plugins/plugins.ts --out profiles/my-plugins
scripts/build-pi.sh --plugins my-plugins/plugins.ts --profile profiles/my-plugins --out out/pi-bolt-plugins
```

## Compatibility checklist

These are the rules for any code bundled into a single executable. Most plugins already follow them.

**Import Pi from its packages, and do not bundle a copy.** Import Pi's API from `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui` and `typebox`. List these as
`peerDependencies` (as Pi's [package guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
requires), not as `dependencies`. The build resolves them to Pi's own modules and leaves out any copy found in the plugin's
`node_modules`. A second copy would mean duplicate classes and registries.

**Use static imports.** The bundler follows `import x from "./file.ts"` and `await import("./file.ts")` with a literal path. It
cannot follow an import or `require()` of a path computed at run time. Replace

```ts
const mod = await import(`./providers/${name}.ts`);
```

with a table of literal imports:

```ts
const providers = { openai: () => import("./providers/openai.ts"), local: () => import("./providers/local.ts") };
const mod = await providers[name]();
```

**Embed files instead of reading them next to the source.** In the executable, `import.meta.dir` and `__dirname` point into the
executable's embedded file system. A prompt, template or WASM file read with `readFile(join(__dirname, "prompt.md"))` is not
there unless it is imported. Import it instead:

```ts
import systemPrompt from "./prompt.md" with { type: "text" }; // the file's contents, as a string
import wasmPath from "./parser.wasm" with { type: "file" };    // a path that fs, Bun.file() and WebAssembly can read
```

**Native addons (`.node`)** load when required by a literal path. Bun embeds them in the executable; the AOT compiler does not
touch them.

**Workers**: pass each worker script to the build with `--plugin-worker`, using its path relative to the manifest's folder.
A Bun executable finds an embedded worker by the path it was built from, not by `new URL(..., import.meta.url)`. That path is
`./.pibolt-plugins/src/` followed by the worker's path relative to the manifest. Start the worker so that it works both
compiled in and loaded at run time:

```ts
// built with: scripts/build-pi.sh --plugins plugins.ts --plugin-worker workers/sum.ts
const url = new URL("./workers/sum.ts", import.meta.url); // relative to this file
const compiledIn = url.href.includes("/$bunfs/");          // running from a compiled executable
const worker = new Worker(compiledIn ? "./.pibolt-plugins/src/workers/sum.ts" : url);
```

**Keep the factory light.** As in stock Pi, register tools, commands and event handlers in the factory. Start processes, sockets,
watchers and timers from `session_start` or from the command that needs them. Anything slow in the factory delays every launch.

**State and configuration**: use the paths Pi gives you (`ctx.cwd`, the agent directory). Do not write next to the plugin's source
files, which are read-only inside the executable.

## Performance guide

Pi-Bolt compiles JavaScript ahead of time, with no type feedback from earlier runs. The compiler works from what it can prove from
the code, plus checks that send unusual cases to a slower generic path. Code whose types are predictable gets the fast paths.
The rules below matter in **hot code**: per-token stream handlers, `context` and `tool_call` event handlers, renderers that run
every frame, and loops over large inputs. Elsewhere, write code the way you normally would.

### Loops

Loops are compiled twice: a fast copy without slow paths, and a generic copy that the fast copy falls back to when a check
fails. The fast copy is used for loops that make no calls, and for loops whose calls are to built-ins with fast paths, to
helpers held in module-level functions or constants, or that index arrays. How a helper is written decides how fast a hot loop runs
(16.8 M iterations; stock Bun's warmed-up JIT for comparison):

| Loop body | Pi-Bolt | Bun 1.4.2 (JIT) |
|---|---:|---:|
| check written inline: `c === 32 \|\| (c >= 9 && c <= 13)` | **29 ms** | 22 ms |
| helper declared at module level: `function isSpace(c) { ... }` | **39 ms** | 27 ms |
| helper in a module constant: `const isSpace = (c) => ...` | **39 ms** | 24 ms |
| helper as a method: `helpers.isSpace(c)` | 243 ms | 24 ms |

- **Keep hot helpers at module level** and call them by name: `function isSpace(c) { ... }` or `const isSpace = (c) => ...`,
  never reassigned. Both are inlined into the loop. Or write small checks inline.
- **Don't call methods in hot loops.** A method looked up on an object (`helpers.isSpace(c)`) is a real call and costs the
  loop its fast copy. Move it to a module-level helper.
- These built-ins have fast paths and do not count as calls: `Math.sqrt/abs/floor/ceil/trunc/fround/min/max/imul`,
  `String.prototype.charCodeAt/charAt/codePointAt`, `Array.prototype.push/pop`, `Array.isArray`, and `Map`/`Set`
  `get/has/set/add`.
- Loop over arrays with an index or `for...of`. Avoid `arguments` and `delete` in hot code.
- Only hot loops need this. A loop that runs a few hundred times per prompt does not.

### Objects

- **Give objects one shape.** Create every field in the constructor or object literal, in the same order, and do not add fields
  later. A property read handles a few shapes with a fast inline check; beyond that it goes through a generic lookup.
- Use `Map` for dictionaries with changing keys, not plain objects with `obj[key]` for arbitrary strings. Its `get`, `has` and
  `set` have fast paths.
- Prefer plain data and classes to `Proxy`, getters and setters in hot paths. They work, but each access calls a function.

### Strings and regular expressions

- **Use regular-expression literals.** A literal (`/^\s*([\w-]+):/`) is compiled to machine code at build time, including
  Unicode (`u`/`v`) patterns. A pattern built from a string at run time (`new RegExp(text)`) is compiled at run time. With the JIT
  off, it then runs in the regular-expression interpreter, unless the training profile recorded it (see
  [step 4](#4-optional-train-a-profile-with-your-plugins)).
- If a pattern has to be dynamic, build it once and keep it in a module-level variable, not once per call.
- Building a long string with `+=` in a loop is fine. For many pieces, `parts.join("")` is cheaper.

### Code that is never compiled ahead of time

`eval`, `new Function(...)`, `vm.runInContext` and code downloaded at run time can only be interpreted on the JIT-off build. If a
plugin depends on them heavily, use the JIT-on build (`--jit on`).

### Startup

- **Import only types from `@earendil-works/pi-coding-agent`** (`import type { ExtensionAPI, ToolDefinition } from ...`). A value
  import from it, even `defineTool`, evaluates Pi's whole public API at startup: about 18 ms per launch in the example plugin.
  `defineTool()` only helps type inference; a typed object literal does the same
  (`const tool: ToolDefinition<typeof parameters> = { ... }`, as in the example). Value imports from `@earendil-works/pi-ai`
  (such as `Type`) and `typebox` are free, because Pi has already loaded them.
- Everything that runs in the factory runs at every launch. Defer expensive set-up (loading large data, compiling grammars,
  connecting to servers) to first use.
- Top-level code of every module runs at startup too. Keep it to declarations.

## Verify and measure

Check that an executable uses its compiled code:

```bash
BUN_STATIC_HEAP_VERBOSE=1 out/pi-bolt-plugins/pi --version 2>&1 | grep "image registered"
# image registered: true
```

Check that your plugins are loaded: Pi lists them at startup under `[Extensions]` as `<inline:name>`.

Time Pi's startup phases, including each plugin's factory:

```bash
PI_TIMING=1 out/pi-bolt-plugins/pi -p "hello"
```

Compare builds end to end with the benchmark tools (see [BENCHMARKS.md](BENCHMARKS.md)):

```bash
python3 bench/benchmark.py --runs 10 --build plugins=out/pi-bolt-plugins/pi --build plain=out/pi-bolt/pi
python3 bench/ui_check.py --project . --build plugins=out/pi-bolt-plugins/pi
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Could not resolve "./something"` during the build | A dynamic import or a file outside the manifest's folder. Use literal imports and keep the plugin's files under the manifest's folder. |
| A tool or command "conflicts" at startup | The plugin is also loaded at run time. Remove the run-time copy ([step 3](#3-remove-the-run-time-copies)). |
| `ENOENT` for a file next to the plugin's source | Embed the file with an `import ... with { type: "text" }` or `{ type: "file" }`. |
| A plugin's hot path is slow on the JIT-off build | Check it against the [performance guide](#performance-guide). As a stopgap, build with `--jit on`. |
| `instanceof` fails, or a registry is empty | A second copy of a Pi package. Move Pi packages to `peerDependencies`; the build excludes `node_modules/@earendil-works/pi-*` and `node_modules/typebox` from the plugin folder. |

// Adapter around CheerpJ (in-browser JVM: https://cheerpj.com) that runs
// two real Java programs client-side: CFR (assets/cfr-0.152.jar) to
// decompile .class -> .java, and javac (bundled in CheerpJ's own JDK) to
// recompile .java -> .class. All CheerpJ API calls live in this file only,
// so if CheerpJ's API changes, the error names exactly which call broke.

const JarToolEngine = (() => {
  const LOADER_URL = "https://cjrtnc.leaningtech.com/4.3/loader.js";
  const CFR_APP_PATH = "/app/assets/cfr-0.152.jar";
  const JAVAC_MAIN = "com.sun.tools.javac.Main";

  let readyPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(s);
    });
  }

  // Tees console.log/warn/error to a user-supplied logger for the
  // duration of a CheerpJ run, since that's where CFR/javac output lands.
  async function withConsoleTee(logFn, fn) {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const forward = (kind) => (...args) => {
      orig[kind].apply(console, args);
      try { logFn(args.map(String).join(" "), kind === "error" ? "err" : "dim"); } catch (_) {}
    };
    console.log = forward("log");
    console.warn = forward("warn");
    console.error = forward("error");
    try {
      return await fn();
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
  }

  async function init(logFn) {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      logFn(`Loading CheerpJ runtime from ${LOADER_URL} ...`, "info");
      await loadScript(LOADER_URL);

      if (typeof cheerpjInit !== "function") {
        throw new Error(
          "cheerpjInit() was not found after loading the CheerpJ loader script. " +
          "CheerpJ's API may have changed, check https://cheerpj.com/docs and " +
          "update LOADER_URL / this check in assets/jartool-engine.js."
        );
      }

      await cheerpjInit();

      for (const fn of ["cheerpjRunMain", "cheerpjRunJar", "cheerpOSAddStringFile", "cjFileBlob"]) {
        if (typeof window[fn] !== "function") {
          throw new Error(
            `CheerpJ loaded, but window.${fn}() is missing. CheerpJ's API may ` +
            "have been renamed, check https://cheerpj.com/docs for the current " +
            "function name and update assets/jartool-engine.js."
          );
        }
      }

      logFn("CheerpJ runtime ready.", "ok");
      return true;
    })();
    return readyPromise;
  }

  /**
   * Decompiles every class in `classPaths` (relative paths like
   * "com/example/Main.class") found inside `jarBytes`, using CFR.
   * Returns a Map of relative ".java" path -> source text. A class
   * missing from the result (e.g. an anonymous inner class CFR folds
   * into its enclosing class) is simply absent from the map.
   */
  async function decompileJar(jarBytes, classPaths, logFn) {
    await init(logFn);

    return withConsoleTee(logFn, async () => {
      // /str/ is a flat store, it has no concept of directories at all
      // (confirmed by CheerpOS itself: "Directories are not supported").
      // Our own input file is a single flat file, so it's fine there, but
      // CFR's --outputdir needs real directories to mirror package names
      // into, so that goes on /files/, the persisted, real filesystem.
      cheerpOSAddStringFile("/str/input.jar", new Uint8Array(jarBytes));

      logFn("Running CFR over the whole jar...", "info");
      const exitCode = await cheerpjRunJar(
        CFR_APP_PATH,
        "/str/input.jar",
        "--outputdir", "/files/decompiled",
        "--silent", "true"
      );

      if (exitCode !== 0) {
        logFn(`CFR exited with code ${exitCode}.`, "err");
      }

      const result = new Map();
      let nestedCount = 0;
      const failed = [];
      for (const classPath of classPaths) {
        // Nested/inner classes (Foo$Bar.class) decompile into their
        // top-level enclosing file (Foo.java), skip them here.
        if (/\$/.test(classPath)) { nestedCount++; continue; }
        const javaPath = classPath.replace(/\.class$/, ".java");
        try {
          // /files/ is a real Java read-write filesystem, but JavaScript
          // has to go through cjFileBlob() to read it back, plain fetch()
          // silently sees nothing there.
          const blob = await cjFileBlob("/files/decompiled/" + javaPath);
          result.set(javaPath, await blob.text());
        } catch (_) {
          failed.push(classPath);
        }
      }
      logFn(`Decompiled ${result.size} of ${classPaths.length} class file(s).`, "ok");
      if (nestedCount > 0) {
        logFn(`${nestedCount} are nested/inner classes, folded into their enclosing file above.`, "dim");
      }
      if (failed.length > 0) {
        logFn(`${failed.length} failed to decompile: ${failed.join(", ")}`, "err");
      }
      return result;
    });
  }

  /**
   * Recompiles a single edited .java source against `classpathJarBytes`
   * (the current state of the jar, so edits to multiple interdependent
   * classes can see each other once each is recompiled in turn).
   * Returns { ok, classBytes, log }.
   */
  async function recompileClass(javaPath, sourceText, classpathJarBytes, logFn) {
    await init(logFn);

    return withConsoleTee(logFn, async () => {
      // As in decompileJar: /str/ can only hold flat files, so the source
      // goes there under its bare filename (javac resolves the package
      // from the "package" statement inside the file, not its path on
      // disk), while javac's -d output, which does need real directories
      // to mirror the package into, goes on /files/.
      const simpleName = javaPath.slice(javaPath.lastIndexOf("/") + 1);
      cheerpOSAddStringFile("/str/classpath.jar", new Uint8Array(classpathJarBytes));
      cheerpOSAddStringFile("/str/" + simpleName, sourceText);

      logFn(`Compiling ${javaPath} ...`, "info");
      // javac itself is part of CheerpJ's bundled JDK, so it needs no extra
      // classpath to be found, only "-cp classpath.jar" as a javac argument
      // for resolving the classes the edited source references.
      const exitCode = await cheerpjRunMain(
        JAVAC_MAIN,
        "",
        "-cp", "/str/classpath.jar",
        "-d", "/files/out",
        "-nowarn",
        "/str/" + simpleName
      );

      if (exitCode !== 0) {
        logFn(`javac exited with code ${exitCode}, recompile failed.`, "err");
        return { ok: false, classBytes: null };
      }

      const classPath = javaPath.replace(/\.java$/, ".class");
      let classBytes;
      try {
        const blob = await cjFileBlob("/files/out/" + classPath);
        classBytes = new Uint8Array(await blob.arrayBuffer());
      } catch (_) {
        logFn(`javac reported success but ${classPath} wasn't found in the output.`, "err");
        return { ok: false, classBytes: null };
      }

      logFn(`Recompiled ${classPath} (${classBytes.length} bytes).`, "ok");
      return { ok: true, classBytes };
    });
  }

  return { init, decompileJar, recompileClass };
})();

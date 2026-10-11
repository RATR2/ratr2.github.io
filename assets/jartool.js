// Jar Workbench UI. Holds one JSZip instance as the live, in-memory state
// of the jar being edited. Every successful recompile or text edit is
// written straight into that zip, so "Export .jar" is just
// zip.generateAsync() of current state.

(() => {
  "use strict";

  let zip = null;              // JSZip instance: current (possibly edited) jar state
  let originalJarBytes = null; // pristine bytes from the file the user opened, for decompiling
  let entries = [];            // [{path, isClass}]
  let sources = new Map();     // javaPath ("com/x/Y.java") -> decompiled/edited source
  let dirtyClasses = new Set();// javaPath currently edited but not (yet) successfully recompiled
  let recompiledClasses = new Set(); // javaPath successfully recompiled at least once
  let activePath = null;       // currently open entry path (as in the zip, e.g. "com/x/Y.class")
  let cm = null;               // CodeMirror instance
  let suppressChange = false;  // guards programmatic editor content swaps

  const el = (id) => document.getElementById(id);
  const treeEl = el("file-tree");
  const consoleEl = el("console-log");
  const engineStatusEl = el("engine-status");
  const engineStatusTextEl = el("engine-status-text");
  const btnDecompileAll = el("btn-decompile-all");
  const btnRecompile = el("btn-recompile");
  const btnExport = el("btn-export");
  const editorFilename = el("editor-filename");
  const editorFlag = el("editor-flag");
  const editorEmpty = el("editor-empty");
  const jarNameEl = el("jar-name");

  function log(message, kind) {
    const line = document.createElement("div");
    line.className = kind ? `log-${kind}` : "";
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${message}`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function setEngineStatus(state, text) {
    engineStatusEl.className = `engine-status ${state}`;
    engineStatusTextEl.textContent = text;
  }

  // ── CodeMirror setup ──

  function ensureEditor() {
    if (cm) return cm;
    cm = CodeMirror.fromTextArea(el("code-editor"), {
      lineNumbers: true,
      theme: "material-darker",
      mode: "text/x-java",
      tabSize: 4,
      indentUnit: 4,
      viewportMargin: Infinity,
    });
    cm.on("change", () => {
      if (suppressChange || !activePath) return;
      onEditorChange();
    });
    return cm;
  }

  function modeForPath(path) {
    if (path.endsWith(".class")) return "text/x-java"; // decompiled source
    if (path.endsWith(".java")) return "text/x-java";
    if (path.endsWith(".xml")) return "application/xml";
    if (/\.(properties|mf|cfg|ini)$/i.test(path)) return "text/x-properties";
    return null;
  }

  function showEditor(show) {
    editorEmpty.style.display = show ? "none" : "flex";
    // CodeMirror hides the original textarea and renders its own themed
    // wrapper element, so toggle that instead of the raw textarea, or we
    // fight CodeMirror and the unstyled plain textarea shows through.
    const c = ensureEditor();
    c.getWrapperElement().style.display = show ? "block" : "none";
    if (show) setTimeout(() => c.refresh(), 0);
  }

  // ── binary sniffing ──

  async function looksLikeText(bytes) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── tree building ──

  function buildTree(paths) {
    const root = { dirs: new Map(), files: [] };
    for (const path of paths) {
      const parts = path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(parts[parts.length - 1]);
    }
    return root;
  }

  function renderTree() {
    treeEl.innerHTML = "";
    if (entries.length === 0) {
      treeEl.innerHTML = '<p class="tree-empty">Open a .jar to see its contents.</p>';
      return;
    }
    const pathByLeaf = new Map(entries.map((e) => [e.path, e]));
    const tree = buildTree(entries.map((e) => e.path));
    treeEl.appendChild(renderNode(tree, "", pathByLeaf));
  }

  function renderNode(node, prefix, pathByLeaf) {
    const frag = document.createDocumentFragment();
    const dirNames = [...node.dirs.keys()].sort();
    for (const name of dirNames) {
      const wrap = document.createElement("div");
      wrap.className = "tree-node";
      const row = document.createElement("div");
      row.className = "tree-row dir";
      row.title = prefix + name;
      row.innerHTML = `<span class="tree-icon">📁</span><span class="tree-label"></span>`;
      row.querySelector(".tree-label").textContent = name;
      wrap.appendChild(row);
      const childWrap = document.createElement("div");
      childWrap.className = "tree-children";
      childWrap.appendChild(renderNode(node.dirs.get(name), prefix + name + "/", pathByLeaf));
      wrap.appendChild(childWrap);
      frag.appendChild(wrap);
    }
    const fileNames = [...node.files].sort();
    for (const name of fileNames) {
      const path = prefix + name;
      const entry = pathByLeaf.get(path);
      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = path;
      row.title = path;
      row.innerHTML = `<span class="tree-icon">${entry.isClass ? "☕" : "📄"}</span><span class="tree-label"></span>`;
      row.querySelector(".tree-label").textContent = name;
      if (entry.isClass) {
        const flag = document.createElement("span");
        flag.className = "flag";
        flag.dataset.flagFor = path;
        row.appendChild(flag);
      }
      row.addEventListener("click", () => openFile(path));
      frag.appendChild(row);
    }
    return frag;
  }

  function updateTreeFlags() {
    for (const e of entries) {
      if (!e.isClass) continue;
      const flagEl = treeEl.querySelector(`[data-flag-for="${CSS.escape(e.path)}"]`);
      if (!flagEl) continue;
      const javaPath = classToJavaPath(e.path);
      if (dirtyClasses.has(javaPath)) flagEl.textContent = "●edited";
      else if (recompiledClasses.has(javaPath)) flagEl.textContent = "✓";
      else flagEl.textContent = "";
    }
  }

  function setActiveRow(path) {
    treeEl.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
    const row = treeEl.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (row) row.classList.add("active");
  }

  function classToJavaPath(classPath) {
    return classPath.replace(/\.class$/, ".java");
  }

  // ── opening a file into the editor ──

  async function openFile(path) {
    activePath = path;
    setActiveRow(path);
    editorFilename.textContent = path;

    const entry = entries.find((e) => e.path === path);
    if (!entry) return;

    if (entry.isClass) {
      const javaPath = classToJavaPath(path);
      if (/\$/.test(path)) {
        showEditor(false);
        editorEmpty.textContent = "This is a nested/inner class, it's decompiled as part of its enclosing class file.";
        btnRecompile.disabled = true;
        editorFlag.textContent = "";
        return;
      }
      const source = sources.get(javaPath);
      if (source === undefined) {
        showEditor(false);
        editorEmpty.textContent = 'Not decompiled yet, click "Decompile all classes" above.';
        btnRecompile.disabled = true;
        editorFlag.textContent = "";
        return;
      }
      showEditor(true);
      suppressChange = true;
      const c = ensureEditor();
      c.setValue(source);
      c.setOption("mode", modeForPath(path));
      suppressChange = false;
      btnRecompile.disabled = !dirtyClasses.has(javaPath);
      editorFlag.textContent = recompiledClasses.has(javaPath) ? "recompiled ✓" : "";
      return;
    }

    // non-class entry
    const zipEntry = zip.file(path);
    if (!zipEntry) return;
    const bytes = await zipEntry.async("uint8array");
    const isText = await looksLikeText(bytes);
    if (!isText) {
      showEditor(false);
      editorEmpty.textContent = `Binary file (${bytes.length.toLocaleString()} bytes), not editable here, carried through to the exported jar unchanged.`;
      btnRecompile.disabled = true;
      editorFlag.textContent = "";
      return;
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    showEditor(true);
    suppressChange = true;
    const c = ensureEditor();
    c.setValue(text);
    c.setOption("mode", modeForPath(path));
    suppressChange = false;
    btnRecompile.disabled = true;
    editorFlag.textContent = "";
  }

  function onEditorChange() {
    const entry = entries.find((e) => e.path === activePath);
    if (!entry) return;

    if (entry.isClass) {
      const javaPath = classToJavaPath(activePath);
      sources.set(javaPath, cm.getValue());
      dirtyClasses.add(javaPath);
      recompiledClasses.delete(javaPath);
      btnRecompile.disabled = false;
      editorFlag.textContent = "";
      updateTreeFlags();
    } else {
      // plain text resource: stage directly into the live zip
      zip.file(activePath, cm.getValue());
    }
  }

  // ── decompile all ──

  btnDecompileAll.addEventListener("click", async () => {
    btnDecompileAll.disabled = true;
    setEngineStatus("loading", "starting JVM…");
    try {
      const classPaths = entries.filter((e) => e.isClass).map((e) => e.path);
      const result = await JarToolEngine.decompileJar(originalJarBytes, classPaths, log);
      for (const [javaPath, source] of result) {
        sources.set(javaPath, source);
      }
      setEngineStatus("ready", "engine ready");
      updateTreeFlags();
      if (activePath) openFile(activePath);
    } catch (err) {
      setEngineStatus("error", "engine error");
      log(String(err && err.stack || err), "err");
      btnDecompileAll.disabled = false;
    }
  });

  // ── recompile active file ──

  btnRecompile.addEventListener("click", async () => {
    if (!activePath) return;
    const javaPath = classToJavaPath(activePath);
    btnRecompile.disabled = true;
    setEngineStatus("loading", "compiling…");
    try {
      const classpathJarBytes = await zip.generateAsync({ type: "uint8array" });
      const { ok, classBytes } = await JarToolEngine.recompileClass(
        javaPath, sources.get(javaPath), classpathJarBytes, log
      );
      setEngineStatus("ready", "engine ready");
      if (ok) {
        zip.file(activePath, classBytes);
        dirtyClasses.delete(javaPath);
        recompiledClasses.add(javaPath);
        editorFlag.textContent = "recompiled ✓";
      } else {
        btnRecompile.disabled = false;
      }
      updateTreeFlags();
    } catch (err) {
      setEngineStatus("error", "engine error");
      log(String(err && err.stack || err), "err");
      btnRecompile.disabled = false;
    }
  });

  // ── open jar ──

  const jarInput = el("jar-input");
  el("btn-open").addEventListener("click", () => jarInput.click());

  jarInput.addEventListener("change", async () => {
    const file = jarInput.files[0];
    if (!file) return;
    log(`Reading ${file.name} (${file.size.toLocaleString()} bytes)...`, "info");
    try {
      const buf = await file.arrayBuffer();
      originalJarBytes = new Uint8Array(buf);
      zip = await JSZip.loadAsync(buf);

      entries = [];
      sources = new Map();
      dirtyClasses = new Set();
      recompiledClasses = new Set();
      activePath = null;

      zip.forEach((path, zipEntry) => {
        if (zipEntry.dir) return;
        entries.push({ path, isClass: path.endsWith(".class") });
      });
      entries.sort((a, b) => a.path.localeCompare(b.path));

      jarNameEl.textContent = file.name;
      renderTree();
      updateTreeFlags();

      btnDecompileAll.disabled = entries.filter((e) => e.isClass).length === 0;
      btnExport.disabled = false;
      btnRecompile.disabled = true;
      editorFilename.textContent = "No file selected";
      editorFlag.textContent = "";
      showEditor(false);
      editorEmpty.textContent = "Pick a file from the tree on the left.";

      log(`Loaded ${entries.length} entries (${entries.filter((e) => e.isClass).length} class files).`, "ok");
    } catch (err) {
      log(`Failed to open jar: ${err}`, "err");
    } finally {
      jarInput.value = "";
    }
  });

  // ── export jar ──

  btnExport.addEventListener("click", async () => {
    if (!zip) return;
    try {
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const baseName = (jarNameEl.textContent || "output.jar").replace(/\.jar$/i, "");
      a.href = url;
      a.download = `${baseName}-edited.jar`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      log(`Exported ${baseName}-edited.jar`, "ok");
    } catch (err) {
      log(`Export failed: ${err}`, "err");
    }
  });

  log("Ready. Open a .jar to get started.", "dim");
})();

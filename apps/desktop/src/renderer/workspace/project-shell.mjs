const staticPolicy = globalThis.trustedTypes?.createPolicy('superwagie-static-ui', {
  createHTML: (value) => value,
});

function staticHtml(value) {
  return staticPolicy ? staticPolicy.createHTML(value) : value;
}

export function showProjectEntry(root, onChoose) {
  root.innerHTML = staticHtml(`
    <section class="project-entry" aria-labelledby="project-entry-title">
      <div class="brand-mark">W</div>
      <p class="eyebrow">LOCAL PRODUCT WORKSPACE</p>
      <h1 id="project-entry-title">打开一个本地 Project</h1>
      <p>目录只会在你选择后交给 Rust Product Core 授权。SuperWagie 不会扫描授权根之外的文件。</p>
      <button type="button" class="primary" id="choose-project">选择 Project…</button>
      <p class="entry-note">当前切片支持 Markdown 编辑、预览、自动保存与冲突恢复。</p>
    </section>`);
  root.querySelector('#choose-project').addEventListener('click', onChoose);
}

export function showWorkspaceShell(root) {
  root.innerHTML = staticHtml(`
    <div class="workspace-shell">
      <nav class="global-rail" aria-label="全局导航">
        <div class="rail-logo" aria-label="SuperWagie">W</div>
        <button class="rail-button active" aria-label="Project 文件">⌘</button>
        <button class="rail-button" aria-label="任务（尚未实现）" disabled>✓</button>
        <button class="rail-button" aria-label="绘图（尚未实现）" disabled>◇</button>
        <button class="rail-button" aria-label="设置（尚未实现）" disabled>⚙</button>
      </nav>
      <aside class="explorer-pane">
        <div class="pane-heading"><span>PROJECT</span><button id="refresh-tree" aria-label="刷新文件列表">↻</button></div>
        <label class="quick-filter"><span>⌘O</span><input id="file-filter" placeholder="快速打开" aria-label="快速打开文件"></label>
        <div id="file-list" class="file-list" role="tree"></div>
      </aside>
      <section class="document-pane">
        <header class="document-topbar">
          <div id="document-tabs" role="tablist"></div>
          <div class="mode-switch" role="group" aria-label="Markdown 显示模式">
            <button data-mode="live" class="active" aria-pressed="true" title="Live Preview：光标所在语法展开，其余内容就地渲染">实时预览</button>
            <button data-mode="source" aria-pressed="false" title="Source Mode：显示全部 Markdown 原文">源码</button>
            <button data-mode="reading" aria-pressed="false" title="Reading View（⌘E / Ctrl+E）">阅读</button>
          </div>
          <span id="save-status" class="save-status" role="status">等待打开文件</span>
        </header>
        <div class="editor-stage" data-mode="live">
          <div id="editor" class="editor-source"></div>
          <article id="preview" class="editor-preview" tabindex="0" aria-label="Markdown 阅读视图"></article>
          <section id="conflict-bar" class="conflict-bar" hidden aria-live="assertive">
            <strong>磁盘内容已在外部改变</strong>
            <span>选择动作前会再次核对最新 revision。</span>
            <div>
              <button data-conflict="merge">合并两份内容</button>
              <button data-conflict="keep_current">保留当前版本</button>
              <button data-conflict="use_disk">使用磁盘版本</button>
            </div>
          </section>
        </div>
      </section>
      <aside class="context-pane">
        <p class="eyebrow">CONTEXT</p>
        <h2>当前文档</h2>
        <dl id="document-meta"><dt>状态</dt><dd>未打开</dd></dl>
        <div class="later-card"><strong>Agent 与 Viewer</strong><p>属于后续切片，当前没有伪造入口或成功状态。</p></div>
        <button type="button" id="revoke-project" class="danger-link">撤销此 Project 授权</button>
      </aside>
      <div id="command-palette" class="command-palette" hidden>
        <label>命令模式 <kbd>⌘P</kbd><input aria-label="命令查询" placeholder="输入命令…"></label>
        <p>此切片暂无可执行 Agent 命令。</p>
      </div>
    </div>`);
  return {
    fileList: root.querySelector('#file-list'),
    fileFilter: root.querySelector('#file-filter'),
    refreshTree: root.querySelector('#refresh-tree'),
    tabs: root.querySelector('#document-tabs'),
    editor: root.querySelector('#editor'),
    preview: root.querySelector('#preview'),
    stage: root.querySelector('.editor-stage'),
    status: root.querySelector('#save-status'),
    conflict: root.querySelector('#conflict-bar'),
    meta: root.querySelector('#document-meta'),
    palette: root.querySelector('#command-palette'),
    revokeProject: root.querySelector('#revoke-project'),
    modeButtons: [...root.querySelectorAll('button[data-mode]')],
  };
}

function ensureCollapsibleStyle(): void {
  if (document.getElementById('bloxplus-collapse-style')) return;
  const style = document.createElement('style');
  style.id = 'bloxplus-collapse-style';
  style.textContent = `
    /* Grouped collapsibles hide the whole section so duplicate titles like
       "Recommended For You" don't stack under the single shared toggle. */
    .bp-collapsed[data-bp-group-member] {
      display: none !important;
    }
    /* Legacy per-section behavior: keep header visible, hide list. */
    .bp-collapsed:not([data-bp-group-member]) > *:not(.home-sort-header-container) {
      display: none !important;
    }
    .bp-collapsed:not([data-bp-group-member]) .home-sort-header-container {
      margin-bottom: 0 !important;
    }
    .bp-section-toggle {
      display: block;
      width: 100%;
      box-sizing: border-box;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      color: inherit;
      padding: 10px 14px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin: 4px 0 16px 0;
      text-align: center;
      font-family: inherit;
    }
    .bp-section-toggle:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.2);
    }
  `;
  document.head.appendChild(style);
}

const GROUP_ID = 'discover';

export function makeGroupCollapsible(sections: HTMLElement[], label: string): void {
  ensureCollapsibleStyle();

  // Drop any leftover per-section toggle buttons from the older code path.
  document
    .querySelectorAll<HTMLElement>('.bp-section-toggle[data-bp-toggle-for]')
    .forEach((b) => b.remove());

  if (sections.length === 0) {
    document
      .querySelectorAll<HTMLElement>(`.bp-section-toggle[data-bp-group="${GROUP_ID}"]`)
      .forEach((b) => b.remove());
    return;
  }

  // Sort by DOM order so the button anchors before the first section visually.
  const ordered = [...sections].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  const first = ordered[0];

  let btn = document.querySelector<HTMLButtonElement>(
    `button.bp-section-toggle[data-bp-group="${GROUP_ID}"]`
  );
  const isFirstRun = !btn;

  // Default to collapsed on first creation; otherwise mirror current state to
  // any newly-arrived sections (e.g. duplicate Recommended that just rendered).
  const collapsed = isFirstRun ? true : first.classList.contains('bp-collapsed');
  for (const s of ordered) {
    s.classList.toggle('bp-collapsed', collapsed);
    s.dataset.bpGroupMember = GROUP_ID;
  }

  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bp-section-toggle';
    btn.dataset.bpGroup = GROUP_ID;
    btn.addEventListener('click', () => {
      const members = document.querySelectorAll<HTMLElement>(
        `[data-bp-group-member="${GROUP_ID}"]`
      );
      if (members.length === 0) return;
      const willCollapse = !members[0].classList.contains('bp-collapsed');
      members.forEach((m) => m.classList.toggle('bp-collapsed', willCollapse));
      updateLabel(btn!, members[0], label);
    });
  }

  if (first.previousElementSibling !== btn) {
    first.insertAdjacentElement('beforebegin', btn);
  }
  updateLabel(btn, first, label);
}

export function cleanupGroupCollapsible(): void {
  document
    .querySelectorAll<HTMLElement>(`.bp-section-toggle[data-bp-group="${GROUP_ID}"]`)
    .forEach((b) => b.remove());
  document.querySelectorAll<HTMLElement>(`[data-bp-group-member="${GROUP_ID}"]`).forEach((s) => {
    s.classList.remove('bp-collapsed');
    delete s.dataset.bpGroupMember;
  });
}

function updateLabel(btn: HTMLElement, ref: HTMLElement, label: string): void {
  btn.textContent = ref.classList.contains('bp-collapsed')
    ? `Show ${label} ▼`
    : `Hide ${label} ▲`;
}

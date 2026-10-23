(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // ---- the workbench clock (the product's own clock, ticking) ----
  const clock = $('#demo-clock');
  const tick = () => {
    if (!clock) return;
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    clock.dateTime = now.toISOString();
  };
  tick();
  setInterval(tick, 1000);

  // ---- hero composer: a real task row is added and checked ----
  const input = $('#demo-task');
  const list = $('#demo-list');
  const addTask = () => {
    const title = (input?.value || '').trim();
    if (!title || !list) return;
    const row = document.createElement('div');
    row.className = 'ui-row';
    row.innerHTML = '<button class="ui-check" type="button" aria-label="标记完成"></button>'
      + '<div class="ui-row-main"><span class="ui-row-title"></span>'
      + '<span class="ui-row-meta">刚刚 · 手动添加</span></div>';
    $('.ui-row-title', row).textContent = title;
    list.prepend(row);
    input.value = '';
    input.focus();
  };
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTask();
    }
  });
  $('[data-demo-add]')?.addEventListener('click', addTask);

  const toggleRow = (row) => {
    if (!row) return;
    row.classList.toggle('is-done');
    const meta = $('.ui-row-meta', row);
    if (meta) {
      if (row.classList.contains('is-done')) {
        meta.textContent = '刚刚完成 · 手动添加';
      } else {
        meta.textContent = '刚刚 · 手动添加';
      }
    }
  };

  list?.addEventListener('click', (event) => {
    const button = event.target.closest('.ui-check');
    if (button) toggleRow(button.closest('.ui-row'));
  });

  // ---- the live row in the showcase ----
  const liveRow = $('#live-row');
  const finishLiveRow = () => toggleRow(liveRow);
  liveRow?.querySelector('.ui-check')?.addEventListener('click', finishLiveRow);
  liveRow?.querySelector('[data-live-done]')?.addEventListener('click', finishLiveRow);

  // ---- section entrances ----
  const revealTargets = $$([
    '.section-head',
    '.section-note',
    '.compare h2',
    '.table-wrap',
    '.split-copy > *',
    '.split-copy .plain-list li',
    '.ui-library',
    '.step',
    '.faq-list h2',
    '.faq-q',
    '.cta-copy > *',
    '.cta-fragment',
    '.desk-shot',
    '.state-item',
    '.how-title',
  ].join(','));
  revealTargets.forEach((el) => el.classList.add('reveal'));

  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    revealTargets.forEach((el) => revealObserver.observe(el));
  } else {
    revealTargets.forEach((el) => el.classList.add('in'));
  }

  // ---- how it works: the stage follows the statement at the middle ----
  const stage = $('#stage');
  const steps = $$('.step');
  if (stage && steps.length && 'IntersectionObserver' in window) {
    const stepObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const state = entry.target.dataset.step;
        if (!state || stage.dataset.state === state) return;
        stage.dataset.state = state;
        steps.forEach((step) => step.classList.toggle('is-active', step === entry.target));
      });
    }, { rootMargin: '-42% 0px -42% 0px' });
    steps.forEach((step) => stepObserver.observe(step));
  }

  // ---- faq: one answer on the right, inline on a phone ----
  const questions = $$('.faq-q');
  const answers = $$('.faq-answer');
  const inline = $$('.faq-inline');
  const setAnswer = (index) => {
    questions.forEach((question, i) => {
      const active = i === index;
      question.classList.toggle('is-active', active);
      question.setAttribute('aria-pressed', String(active));
    });
    answers.forEach((answer, i) => {
      answer.hidden = i !== index;
    });
    inline.forEach((answer, i) => {
      answer.hidden = i !== index;
    });
  };
  questions.forEach((question, index) => {
    question.addEventListener('click', () => setAnswer(index));
    question.addEventListener('focus', () => setAnswer(index));
  });
  if (questions.length) setAnswer(0);

  // ---- the desk photograph drifts as the page passes it ----
  const band = $('.photo-band');
  const bandImg = $('.band-img');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (band && bandImg && !reduced.matches) {
    let ticking = false;
    const drift = () => {
      ticking = false;
      const rect = band.getBoundingClientRect();
      const view = window.innerHeight || 1;
      const progress = Math.min(1, Math.max(0, (view - rect.top) / (view + rect.height)));
      bandImg.style.transform = `scale(${1.06 - progress * 0.06})`;
    };
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(drift);
    }, { passive: true });
    drift();
  }
})();

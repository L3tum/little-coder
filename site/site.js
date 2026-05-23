/* little-coder site — animations */
(() => {
  // ---------- reveal on scroll ----------
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        revealObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal, .reveal-up').forEach(el => revealObserver.observe(el));

  // ---------- count-up ----------
  function countUp(el, to, duration = 1600) {
    const start = performance.now();
    const startVal = parseFloat(el.textContent) || 0;
    const decimals = el.dataset.decimals !== undefined
      ? parseInt(el.dataset.decimals, 10)
      : (String(to).includes('.') ? 2 : 0);
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = startVal + (to - startVal) * eased;
      el.textContent = v.toFixed(decimals);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // start counts + bench bar fill once visible
  const benchObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.querySelectorAll('.bench-bar').forEach(b => b.classList.add('in'));
      e.target.querySelectorAll('.count').forEach(c => {
        const to = parseFloat(c.dataset.to);
        countUp(c, to, 1700);
      });
      benchObserver.unobserve(e.target);
    });
  }, { threshold: 0.4 });
  document.querySelectorAll('[data-anim="bench"]').forEach(el => benchObserver.observe(el));

  // community counters (separate, simpler)
  const commObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.querySelectorAll('.count').forEach(c => {
        const to = parseFloat(c.dataset.to);
        countUp(c, to, 1500);
        c.dataset.counted = '1';
      });
      commObserver.unobserve(e.target);
    });
  }, { threshold: 0.3 });
  document.querySelectorAll('.comm-stats').forEach(el => commObserver.observe(el));

  // ---------- live GitHub stats (graceful fallback to hardcoded data-to) ----------
  (async function refreshStats() {
    const REPO = 'itayinbarr/little-coder';
    const set = (key, val) => {
      if (!Number.isFinite(val)) return;
      const el = document.querySelector(`.count[data-stat="${key}"]`);
      if (!el) return;
      el.dataset.to = String(val);
      // if the counter already animated (user scrolled past before fetch landed),
      // re-run it to the fresh value
      if (el.dataset.counted === '1') countUp(el, val, 900);
    };
    const j = async (url) => {
      const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(r.status);
      return r.json();
    };
    try {
      const [repo, all, closed] = await Promise.all([
        j(`https://api.github.com/repos/${REPO}`),
        j(`https://api.github.com/search/issues?q=repo:${REPO}+type:issue&per_page=1`),
        j(`https://api.github.com/search/issues?q=repo:${REPO}+type:issue+state:closed&per_page=1`),
      ]);
      set('stars', repo.stargazers_count);
      set('issues', all.total_count);
      set('resolved', closed.total_count);
    } catch (_) {
      /* offline / rate-limited → keep the hardcoded fallback numbers */
    }
  })();

  // ---------- live version (latest GitHub release tag) ----------
  (async function refreshVersion() {
    try {
      const r = await fetch('https://api.github.com/repos/itayinbarr/little-coder/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) throw new Error(r.status);
      const v = String((await r.json()).tag_name || '').replace(/^v/, '');
      if (v) document.querySelectorAll('[data-version]').forEach(el => { el.textContent = v; });
    } catch (_) {
      /* offline / no release / rate-limited → keep the hardcoded fallback version */
    }
  })();

  // ---------- typing engine ----------
  function typeInto(el, text, speed = 36) {
    return new Promise((resolve) => {
      el.textContent = '';
      let i = 0;
      const id = setInterval(() => {
        el.textContent += text[i];
        i++;
        if (i >= text.length) {
          clearInterval(id);
          resolve();
        }
      }, speed);
    });
  }
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // the commands the two terminals type, single-sourced so the up-front height
  // reservation below types the exact same final text the animation will.
  const INSTALL_CMDS = [
    'npm install -g little-coder',
    'llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF',
    'little-coder --model llamacpp/qwen3.6-35b-a3b',
  ];
  const SESSION_CMD = 'implement the fizzbuzz exercise';

  // Pin a terminal's *final* height before its animation starts, so the box
  // never grows (and shoves the page down) as commands type in and outputs
  // reveal. The CSS min-height is correct on desktop, where each command fits
  // on one line — but on mobile the long commands wrap to extra lines, so the
  // fully-revealed terminal is much taller than the static reservation and the
  // page visibly jumps mid-animation. We render the final state, measure it at
  // the current viewport width, and pin that as min-height. Done synchronously
  // (fill → measure → the caller's reset, with no await between) so the filled
  // state is never painted; clearing min-height first keeps the CSS value as a
  // floor so we never reserve *less* than desktop.
  function reserveTerminalHeight(root, fill) {
    const body = root && root.querySelector('.t-body');
    if (!body) return;
    body.style.minHeight = '';
    fill();
    body.style.minHeight = Math.ceil(body.getBoundingClientRect().height) + 'px';
  }
  function fillInstallFinal(root) {
    root.querySelectorAll('.t-line').forEach(l => { l.style.visibility = 'visible'; });
    root.querySelectorAll('.cmd').forEach((c, i) => { c.textContent = INSTALL_CMDS[i] ?? ''; });
    root.querySelectorAll('.t-out').forEach(o => o.classList.add('show'));
  }
  function fillSessionFinal(root) {
    const u = root.querySelector('.user');
    if (u) u.textContent = SESSION_CMD;
    root.querySelectorAll('.s-out').forEach(o => o.classList.add('show'));
  }
  // restore a terminal to its pre-animation frame (first prompt visible, the
  // rest empty/hidden)
  function resetInstall(root) {
    root.querySelectorAll('.t-out').forEach(o => o.classList.remove('show'));
    root.querySelectorAll('.cmd').forEach(c => { c.textContent = ''; });
    root.querySelectorAll('.caret').forEach(c => c.classList.remove('hide'));
    root.querySelectorAll('.bar-fill').forEach(b => b.classList.remove('go'));
    root.querySelectorAll('[data-step]').forEach(el => {
      if (el.classList.contains('t-line')) el.style.visibility = 'hidden';
    });
    const first = root.querySelectorAll('.t-line')[0];
    if (first) first.style.visibility = 'visible';
  }
  function resetSession(root) {
    root.querySelectorAll('.s-out').forEach(o => o.classList.remove('show'));
    root.querySelectorAll('.user').forEach(u => { u.textContent = ''; });
    root.querySelectorAll('.caret').forEach(c => c.classList.remove('hide'));
  }
  // Pin final height AND leave the terminal in its initial frame — run at load
  // (so the box is its final size before it's ever scrolled into view, no jump)
  // and again on resize. fill → measure → reset is synchronous, so neither the
  // filled nor a half-state is ever painted.
  function primeInstall(root) {
    if (!root) return;
    reserveTerminalHeight(root, () => fillInstallFinal(root));
    resetInstall(root);
  }
  function primeSession(root) {
    if (!root) return;
    reserveTerminalHeight(root, () => fillSessionFinal(root));
    resetSession(root);
  }

  // ---------- install terminal sequence ----------
  let installTimer = null;
  async function playInstall(root) {
    if (!root) return;
    clearTimeout(installTimer);
    // re-pin the final height for the current viewport, then reset to the
    // initial frame (both synchronous — the filled state is never painted)
    primeInstall(root);

    const lines = root.querySelectorAll('.t-line');
    const outs = root.querySelectorAll('.t-out');
    const carets = root.querySelectorAll('.caret');

    // line 1: npm install
    await wait(300);
    await typeInto(lines[0].querySelector('.cmd'), INSTALL_CMDS[0], 36);
    carets[0].classList.add('hide');
    await wait(220);
    outs[0].classList.add('show');
    await wait(120);
    root.querySelector('.bar-fill').classList.add('go');
    await wait(2900);

    // line 2: llama-server (pull + serve the model)
    lines[1].style.visibility = 'visible';
    carets[1].classList.remove('hide');
    await typeInto(lines[1].querySelector('.cmd'), INSTALL_CMDS[1], 30);
    carets[1].classList.add('hide');
    await wait(220);
    outs[1].classList.add('show');
    await wait(1100);

    // line 3: little-coder --model llamacpp/qwen3.6-35b-a3b
    lines[2].style.visibility = 'visible';
    carets[2].classList.remove('hide');
    await typeInto(lines[2].querySelector('.cmd'), INSTALL_CMDS[2], 50);
    carets[2].classList.add('hide');
    await wait(200);
    outs[2].classList.add('show');

    // smoothly replay 10s after the sequence finishes
    installTimer = setTimeout(() => playInstall(root), 10000);
  }

  // track which terminals have begun, so a viewport resize can re-pin their
  // height (the reservation is width-dependent) without starting one early.
  let installStarted = false;
  let sessionStarted = false;

  // play install once on view; then it loops itself
  const installRoot = document.querySelector('.install-terminal');
  const installObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      installStarted = true;
      playInstall(installRoot);
      installObserver.unobserve(e.target);
    });
  }, { threshold: 0.3 });
  if (installRoot) installObserver.observe(installRoot);

  // ---------- sample session: real tool-use flow ----------
  async function playSession(root) {
    if (!root) return;
    // re-pin the final height for the current viewport, then reset (synchronous)
    primeSession(root);

    const lines = root.querySelectorAll('.s-line');
    const outs = root.querySelectorAll('.s-out');
    const carets = root.querySelectorAll('.caret');

    // type the request
    await wait(400);
    await typeInto(lines[0].querySelector('.user'), SESSION_CMD, 30);
    carets[0].classList.add('hide');
    await wait(320);
    outs[0].classList.add('show');   // running...
    await wait(700);
    outs[1].classList.add('show');   // tool-use flow (lines stagger in via CSS)
    await wait(2500);
    outs[2].classList.add('show');   // All tests pass. + status line
  }

  const sessionRoot = document.querySelector('.session-terminal');
  const sessionObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      sessionStarted = true;
      playSession(sessionRoot);
      sessionObserver.unobserve(e.target);
    });
  }, { threshold: 0.25 });
  if (sessionRoot) sessionObserver.observe(sessionRoot);

  // Pin both terminals' final heights up-front — before either is scrolled
  // into view — so entering the viewport never triggers a CSS-floor→final jump,
  // only the typing animation inside an already-correctly-sized box. Each
  // prime leaves the terminal in its initial frame.
  primeInstall(installRoot);
  primeSession(sessionRoot);

  // The reservation depends on text wrapping, which depends on the font. IBM
  // Plex Mono loads async, so the load-time pin above uses fallback-monospace
  // metrics; re-pin once the real font is ready (the terminals are below the
  // fold, so this lands before they're ever seen). Skip any already animating —
  // it pinned with the loaded font when it started.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (!installStarted) primeInstall(installRoot);
      if (!sessionStarted) primeSession(sessionRoot);
    }).catch(() => {});
  }

  // On resize / orientation change the wrapped final height changes. Re-pin both
  // (so far-off terminals stay correct), and replay the ones already animating
  // so their reservation matches the new width mid-flight.
  let resizeTimer = null;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastW) return; // ignore mobile scroll-driven toolbar height changes
    lastW = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (installStarted) playInstall(installRoot); else primeInstall(installRoot);
      if (sessionStarted) playSession(sessionRoot); else primeSession(sessionRoot);
    }, 250);
  });

  // ---------- hero tagline rotator ----------
  // The lead cycles through a few positioning lines, ~5s each. The static prefix
  // "a coding agent built " never retypes — only the tail rotates, with a solid
  // honey cursor while typing and a blinking one at rest. We pin the lead to its
  // tallest phrase first so the rotating tail never reflows the page (the same
  // no-jump discipline as the terminals above).
  (function heroRotate() {
    const lead = document.querySelector('.hero-lead');
    const tail = lead && lead.querySelector('.lead-tail');
    const cursor = lead && lead.querySelector('.lead-cursor');
    if (!lead || !tail) return;

    const TAILS = [
      'for small models',
      'for tending to your personal documents',
      'for when you hit Claude Code’s limit',
    ];
    const DWELL = 5000; // each phrase stays readable ~5s before it changes
    const TYPE = 42;    // ms per typed character
    const ERASE = 24;   // ms per erased character

    // Reserve the tallest phrase's rendered height up front, re-pinning on font
    // load and width change, so a longer tail never grows the box and shoves the
    // page down (mirrors reserveTerminalHeight for the terminals).
    function pinHeight() {
      const cur = tail.textContent;
      lead.style.minHeight = '';
      let max = 0;
      for (const t of TAILS) { tail.textContent = t; max = Math.max(max, lead.getBoundingClientRect().height); }
      tail.textContent = cur;
      lead.style.minHeight = Math.ceil(max) + 'px';
    }
    pinHeight();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(pinHeight).catch(() => {});
    let pinTimer = null, pinW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === pinW) return; // ignore mobile scroll-driven toolbar resizes
      pinW = window.innerWidth;
      clearTimeout(pinTimer);
      pinTimer = setTimeout(pinHeight, 200);
    });

    // Honor reduced-motion: leave the first phrase static, no type/erase.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const solid = () => cursor && cursor.classList.remove('blink');
    const rest = () => cursor && cursor.classList.add('blink');

    (async function loop() {
      let i = 0;
      await sleep(DWELL); // hold the first (already-rendered) phrase
      while (true) {
        solid();
        while (tail.textContent.length) { tail.textContent = tail.textContent.slice(0, -1); await sleep(ERASE); }
        i = (i + 1) % TAILS.length;
        const next = TAILS[i];
        for (let c = 0; c < next.length; c++) { tail.textContent += next[c]; await sleep(TYPE); }
        rest();
        await sleep(DWELL);
      }
    })();
  })();

})();

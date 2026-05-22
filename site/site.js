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
    const decimals = String(to).includes('.') ? 2 : 0;
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

  // ---------- install terminal sequence ----------
  let installTimer = null;
  async function playInstall(root) {
    if (!root) return;
    clearTimeout(installTimer);
    // reset
    root.querySelectorAll('.t-out').forEach(o => o.classList.remove('show'));
    root.querySelectorAll('.cmd').forEach(c => { c.textContent = ''; });
    root.querySelectorAll('.caret').forEach(c => c.classList.remove('hide'));
    root.querySelectorAll('.bar-fill').forEach(b => b.classList.remove('go'));
    root.querySelectorAll('[data-step]').forEach(el => {
      if (el.classList.contains('t-line')) {
        el.style.visibility = 'hidden';
      }
    });
    root.querySelectorAll('.t-line')[0].style.visibility = 'visible';

    const lines = root.querySelectorAll('.t-line');
    const outs = root.querySelectorAll('.t-out');
    const carets = root.querySelectorAll('.caret');

    // line 1: npm install
    await wait(300);
    await typeInto(lines[0].querySelector('.cmd'), 'npm install -g little-coder', 36);
    carets[0].classList.add('hide');
    await wait(220);
    outs[0].classList.add('show');
    await wait(120);
    root.querySelector('.bar-fill').classList.add('go');
    await wait(2900);

    // line 2: llama-server (pull + serve the model)
    lines[1].style.visibility = 'visible';
    carets[1].classList.remove('hide');
    await typeInto(lines[1].querySelector('.cmd'), 'llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF', 30);
    carets[1].classList.add('hide');
    await wait(220);
    outs[1].classList.add('show');
    await wait(1100);

    // line 3: little-coder --model llamacpp/qwen3.6-35b-a3b
    lines[2].style.visibility = 'visible';
    carets[2].classList.remove('hide');
    await typeInto(lines[2].querySelector('.cmd'), 'little-coder --model llamacpp/qwen3.6-35b-a3b', 50);
    carets[2].classList.add('hide');
    await wait(200);
    outs[2].classList.add('show');

    // smoothly replay 10s after the sequence finishes
    installTimer = setTimeout(() => playInstall(root), 10000);
  }

  // play install once on view; then it loops itself
  const installRoot = document.querySelector('.install-terminal');
  const installObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      playInstall(installRoot);
      installObserver.unobserve(e.target);
    });
  }, { threshold: 0.3 });
  if (installRoot) installObserver.observe(installRoot);

  // ---------- sample session: real tool-use flow ----------
  async function playSession(root) {
    if (!root) return;
    root.querySelectorAll('.s-out').forEach(o => o.classList.remove('show'));
    root.querySelectorAll('.user').forEach(u => { u.textContent = ''; });
    root.querySelectorAll('.caret').forEach(c => c.classList.remove('hide'));

    const lines = root.querySelectorAll('.s-line');
    const outs = root.querySelectorAll('.s-out');
    const carets = root.querySelectorAll('.caret');

    // type the request
    await wait(400);
    await typeInto(lines[0].querySelector('.user'), 'implement the fizzbuzz exercise', 30);
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
      playSession(sessionRoot);
      sessionObserver.unobserve(e.target);
    });
  }, { threshold: 0.25 });
  if (sessionRoot) sessionObserver.observe(sessionRoot);

})();

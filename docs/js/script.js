document.addEventListener('DOMContentLoaded', () => {
  const html = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  const hamburger = document.getElementById('hamburger');
  const mobileNav = document.getElementById('mobileNav');
  const overlay = document.getElementById('navOverlay');

  const saved = localStorage.getItem('theme');
  if (saved === 'dark') html.classList.add('dark');

  const sunIcon = document.getElementById('sunIcon');
  const moonIcon = document.getElementById('moonIcon');
  function syncThemeIcons() {
    const isDark = html.classList.contains('dark');
    if (sunIcon) sunIcon.style.display = isDark ? 'block' : 'none';
    if (moonIcon) moonIcon.style.display = isDark ? 'none' : 'block';
  }
  syncThemeIcons();

  toggle?.addEventListener('click', () => {
    html.classList.toggle('dark');
    localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
    syncThemeIcons();
  });

  function closeNav() { mobileNav?.classList.remove('open'); overlay?.classList.remove('open'); }
  function openNav() { mobileNav?.classList.add('open'); overlay?.classList.add('open'); }

  hamburger?.addEventListener('click', () => {
    mobileNav?.classList.contains('open') ? closeNav() : openNav();
  });
  overlay?.addEventListener('click', closeNav);
  mobileNav?.querySelector('.close-nav')?.addEventListener('click', closeNav);

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const blobs = document.querySelectorAll('.blob');
    if (blobs.length) {
      let mx = 0, my = 0, ticking = false;
      document.addEventListener('mousemove', e => {
        mx = (e.clientX / window.innerWidth - 0.5) * 20;
        my = (e.clientY / window.innerHeight - 0.5) * 20;
        if (!ticking) {
          requestAnimationFrame(() => {
            blobs.forEach((b, i) => {
              const speed = 1 + i * 0.6;
              b.style.transform = `translate(${mx * speed}px, ${my * speed}px)`;
            });
            ticking = false;
          });
          ticking = true;
        }
      });
    }
  }

  const cards = document.querySelectorAll('.feature-card');
  if (cards.length) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          setTimeout(() => {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
          }, i * 80);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    cards.forEach(c => {
      c.style.opacity = '0';
      c.style.transform = 'translateY(20px)';
      c.style.transition = 'opacity .5s ease, transform .5s ease';
      observer.observe(c);
    });
  }

  const gotop = document.getElementById('gotop');
  if (gotop) {
    window.addEventListener('scroll', () => {
      gotop.classList.toggle('show', window.scrollY > 400);
    });
    gotop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (id === '#') return;
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        closeNav();
      }
    });
  });
});

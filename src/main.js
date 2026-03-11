/* ================================================
   main.js — portfolio logic
   ================================================ */

document.addEventListener("DOMContentLoaded", () => {
  setYear();
  renderProjects();
  renderSkills();
  buildFilterBar();
  animateCounters();
  initTypedEffect();
  initScrollReveal();
  initMobileNav();
});

// ── Year ──────────────────────────────────────
function setYear() {
  document.getElementById("year").textContent = new Date().getFullYear();
}

// ── Render Projects ───────────────────────────
function renderProjects(filter = "all") {
  const grid = document.getElementById("projects-grid");
  grid.innerHTML = "";

  const list = filter === "all"
    ? PROJECTS
    : PROJECTS.filter((p) => p.tags.map(t => t.toLowerCase()).includes(filter.toLowerCase()));

  // Featured projects first
  const sorted = [...list].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));

  sorted.forEach((proj, i) => {
    const card = document.createElement("article");
    card.className = "project-card reveal";
    card.style.animationDelay = `${i * 60}ms`;

    const imgHTML = proj.image
      ? `<img src="${proj.image}" alt="${proj.title}" class="project-img" loading="lazy" />`
      : `<div class="project-img-placeholder" data-label="PCB Design"></div>`;

    const tagsHTML = proj.tags
      .map((t) => `<span class="tag">${t}</span>`)
      .join("");

    const linksHTML = proj.links
      .map((l) => `<a href="${l.url}" class="btn btn-sm" target="_blank" rel="noopener">${l.label}</a>`)
      .join("");

    const featuredBadge = proj.featured
      ? `<span class="featured-badge">Featured</span>`
      : "";

    const viewDetailsBtn = proj.page
      ? `<a href="${proj.page}" class="btn btn-sm btn-details">View Details &#8594;</a>`
      : "";

    card.innerHTML = `
      ${imgHTML}
      <div class="project-body">
        <div class="project-header">
          <h3 class="project-title">${proj.title}</h3>
          ${featuredBadge}
        </div>
        <p class="project-desc">${proj.description}</p>
        <div class="project-tags">${tagsHTML}</div>
        <div class="project-links">${linksHTML}${viewDetailsBtn}</div>
      </div>
    `;

    if (proj.page) {
      card.style.cursor = "pointer";
      card.addEventListener("click", (e) => {
        if (e.target.closest("a")) return; // let link clicks pass through
        window.location.href = proj.page;
      });
    }

    grid.appendChild(card);
  });

  if (sorted.length === 0) {
    grid.innerHTML = `<p class="empty-state">No projects match this filter.</p>`;
  }

  observeNewCards();
}

// ── Filter Bar ────────────────────────────────
function buildFilterBar() {
  const allTags = [...new Set(PROJECTS.flatMap((p) => p.tags))].sort();
  const bar = document.querySelector(".filter-bar");

  allTags.forEach((tag) => {
    const btn = document.createElement("button");
    btn.className = "filter-btn";
    btn.dataset.filter = tag;
    btn.textContent = tag;
    bar.appendChild(btn);
  });

  bar.addEventListener("click", (e) => {
    if (!e.target.classList.contains("filter-btn")) return;
    bar.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    e.target.classList.add("active");
    renderProjects(e.target.dataset.filter);
  });
}

// ── Render Skills ─────────────────────────────
function renderSkills() {
  const grid = document.getElementById("skills-grid");
  SKILLS.forEach((group) => {
    const el = document.createElement("div");
    el.className = "skill-group reveal";
    el.innerHTML = `
      <h3 class="skill-category">${group.category}</h3>
      <ul class="skill-list">
        ${group.items.map((s) => `<li class="skill-item">${s}</li>`).join("")}
      </ul>
    `;
    grid.appendChild(el);
  });
}

// ── Animated Counters ─────────────────────────
function animateCounters() {
  document.getElementById("projects-count").dataset.target = PROJECTS.length;
  const allSkills = SKILLS.flatMap((g) => g.items);
  document.getElementById("skills-count").dataset.target = allSkills.length;

  const counters = document.querySelectorAll(".stat-number[data-target]");
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseInt(el.dataset.target, 10);
      let current = 0;
      const step = Math.ceil(target / 40);
      const timer = setInterval(() => {
        current = Math.min(current + step, target);
        el.textContent = current;
        if (current >= target) clearInterval(timer);
      }, 30);
      obs.unobserve(el);
    });
  }, { threshold: 0.5 });

  counters.forEach((c) => obs.observe(c));
}

// ── Typed Effect ──────────────────────────────
function initTypedEffect() {
  const el = document.querySelector(".typed-text");
  if (!el || !ROLES.length) return;

  let roleIndex = 0;
  let charIndex = 0;
  let deleting = false;

  function tick() {
    const role = ROLES[roleIndex];
    if (deleting) {
      el.textContent = role.substring(0, --charIndex);
    } else {
      el.textContent = role.substring(0, ++charIndex);
    }

    let delay = deleting ? 50 : 100;

    if (!deleting && charIndex === role.length) {
      delay = 1800;
      deleting = true;
    } else if (deleting && charIndex === 0) {
      deleting = false;
      roleIndex = (roleIndex + 1) % ROLES.length;
      delay = 400;
    }

    setTimeout(tick, delay);
  }

  tick();
}

// ── Scroll Reveal ─────────────────────────────
let revealObserver = null;

function initScrollReveal() {
  revealObserver = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("revealed");
        revealObserver.unobserve(e.target);
      }
    }),
    { threshold: 0.1 }
  );

  setTimeout(() => {
    document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
  }, 100);
}

function observeNewCards() {
  if (!revealObserver) return;
  document.querySelectorAll(".reveal:not(.revealed)").forEach((el) => revealObserver.observe(el));
}

// ── Mobile Nav ────────────────────────────────
function initMobileNav() {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");

  toggle?.addEventListener("click", () => {
    links.classList.toggle("open");
  });

  links?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => links.classList.remove("open"));
  });
}

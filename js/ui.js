// Shared UI utilities: toast, modal, loading overlay

// ===== Toast =====

export function toast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ===== Loading Overlay =====

export function showLoading(text = 'Processing...') {
  const overlay = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text;
  overlay.classList.remove('hidden');
}

export function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ===== Modal =====

export function showModal(title, message, actions) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;

    const actionsContainer = document.getElementById('modal-actions');
    actionsContainer.innerHTML = '';

    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = `btn ${action.class || 'btn-secondary'} btn-sm`;
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        overlay.classList.add('hidden');
        resolve(action.value);
      });
      actionsContainer.appendChild(btn);
    });

    overlay.classList.remove('hidden');

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.add('hidden');
        resolve(null);
      }
    }, { once: true });
  });
}

export function confirm(title, message) {
  return showModal(title, message, [
    { label: 'Cancel', value: false, class: 'btn-secondary' },
    { label: 'Confirm', value: true, class: 'btn-danger' }
  ]);
}

// ===== View Navigation =====

const viewHistory = [];

export function showView(viewId) {
  const current = document.querySelector('.view.active');
  if (current) {
    viewHistory.push(current.id);
    current.classList.remove('active');
  }

  const next = document.getElementById(viewId);
  if (next) {
    next.classList.add('active');
  }

  // Update tab bar active state for main views
  const mainViews = ['view-scan', 'view-dashboard', 'view-listings', 'view-collection', 'view-settings'];
  if (mainViews.includes(viewId)) {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.toggle('active', `view-${tab.dataset.view}` === viewId);
    });
  }
}

export function goBack() {
  const prevId = viewHistory.pop();
  if (prevId) {
    document.querySelector('.view.active')?.classList.remove('active');
    document.getElementById(prevId)?.classList.add('active');

    // Update tab bar
    const mainViews = ['view-scan', 'view-dashboard', 'view-listings', 'view-collection', 'view-settings'];
    if (mainViews.includes(prevId)) {
      document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', `view-${tab.dataset.view}` === prevId);
      });
    }
  }
}

// ===== Utility =====

export function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function $(selector) {
  return document.querySelector(selector);
}

export function $$(selector) {
  return document.querySelectorAll(selector);
}

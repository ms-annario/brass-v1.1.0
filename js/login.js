/* BRASS — login gate & role management */
(function () {
  const USER = 'johndoe', PASS = 'bops';
  const root = document.documentElement;
  const form = document.getElementById('login-form');
  if (!form) return;
  const err = document.getElementById('login-error');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    if (u === USER && p === PASS) {
      try { sessionStorage.setItem('brass-auth', '1'); } catch (x) {}
      root.classList.add('authed');
      // The canvas was sized while hidden; let it re-measure
      window.dispatchEvent(new Event('brass-login'));
    } else {
      err.hidden = false;
      document.getElementById('login-pass').value = '';
      document.getElementById('login-pass').focus();
    }
  });

  // Role & User Profile Management
  const B = (window.B = window.B || {});
  const SYSTEM_USERS = [
    { id: 'admin', name: 'Alex Tan', role: 'Admin', initials: 'AT', email: 'alex.tan@brass.sg' },
    { id: 'bops-1', name: 'John Doe', role: 'Bus Ops', initials: 'JD', email: 'john.doe@brass.sg' },
    { id: 'bops-2', name: 'Sarah Lim', role: 'Bus Ops', initials: 'SL', email: 'sarah.lim@brass.sg' },
    { id: 'lead-1', name: 'Marcus Chen', role: 'Bus Ops', initials: 'MC', email: 'marcus.chen@brass.sg' },
    { id: 'eng-1', name: 'Priya Sharma', role: 'Bus Ops', initials: 'PS', email: 'priya.sharma@brass.sg' },
    { id: 'ops-3', name: 'David Wong', role: 'Bus Ops', initials: 'DW', email: 'david.wong@brass.sg' }
  ];
  B.SYSTEM_USERS = SYSTEM_USERS;
  const USERS = {
    'Admin': SYSTEM_USERS[0],
    'Bus Ops': SYSTEM_USERS[1],
    'bops-1': SYSTEM_USERS[1],
    'bops-2': SYSTEM_USERS[2],
    'admin': SYSTEM_USERS[0]
  };
  B.USERS = USERS;
  const DEFAULT_ROLE = 'Bus Ops';

  let currentUserId = localStorage.getItem('brass-user-id') || 'bops-1';
  let currentUser = SYSTEM_USERS.find((u) => u.id === currentUserId) || SYSTEM_USERS[1];
  let currentRole = currentUser.role || DEFAULT_ROLE;
  B.currentRole = currentRole;
  B.currentUser = currentUser;

  const updateRoleUI = (roleOrUser) => {
    let user = null;
    if (typeof roleOrUser === 'object' && roleOrUser) {
      user = roleOrUser;
    } else if (SYSTEM_USERS.some((u) => u.id === roleOrUser)) {
      user = SYSTEM_USERS.find((u) => u.id === roleOrUser);
    } else if (roleOrUser === 'Admin') {
      user = SYSTEM_USERS[0];
    } else {
      user = SYSTEM_USERS[1];
    }

    currentUser = user;
    currentRole = user.role;
    B.currentRole = currentRole;
    B.currentUser = user;
    try {
      localStorage.setItem('brass-user-id', user.id);
      localStorage.setItem('brass-user-role', currentRole);
    } catch (e) {}

    const nameLabel = document.getElementById('header-profile-name');
    if (nameLabel) nameLabel.textContent = user.name;

    const avatarEl = document.getElementById('header-profile-avatar');
    if (avatarEl) avatarEl.textContent = user.initials;

    const roleLabel = document.getElementById('header-profile-role');
    if (roleLabel) roleLabel.textContent = user.role;

    const heroName = document.getElementById('home-hero-user-name');
    if (heroName) heroName.textContent = user.name;

    const heroRole = document.getElementById('home-hero-role');
    if (heroRole) heroRole.textContent = user.role;

    const items = document.querySelectorAll('.profile-role-item');
    items.forEach((item) => {
      const match = (item.dataset.user && item.dataset.user === user.id) ||
                    (!item.dataset.user && item.dataset.role === user.role);
      item.classList.toggle('active', match);
      const check = item.querySelector('.profile-role-check');
      if (check) check.textContent = match ? '✓' : '';
    });

    // Access control: User menu visible only for Admin role
    const navUsers = document.getElementById('nav-item-users');
    if (navUsers) {
      const isAdmin = (currentRole === 'Admin');
      navUsers.hidden = !isAdmin;
      navUsers.style.display = isAdmin ? '' : 'none';
    }

    // If non-admin user is on users page, exit immediately
    const usersPage = document.getElementById('users-page');
    if (currentRole !== 'Admin' && usersPage && !usersPage.hidden) {
      const projectsPage = document.getElementById('projects-page');
      if (projectsPage) projectsPage.hidden = false;
      usersPage.hidden = true;
      const navProjects = document.getElementById('nav-item-projects');
      if (navProjects) {
        navProjects.classList.add('active');
        navProjects.setAttribute('aria-current', 'page');
      }
      if (navUsers) {
        navUsers.classList.remove('active');
        navUsers.removeAttribute('aria-current');
      }
    }

    window.dispatchEvent(new CustomEvent('brass-role-change', { detail: { role: currentRole, user } }));
  };

  // Profile menu toggle & actions
  const profileBtn = document.getElementById('global-profile-btn');
  const profileMenu = document.getElementById('global-profile-menu');

  const setMenuOpen = (open) => {
    if (!profileMenu) return;
    profileMenu.hidden = !open;
    if (profileBtn) profileBtn.setAttribute('aria-expanded', String(open));
  };

  if (profileBtn && profileMenu) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMenuOpen(profileMenu.hidden);
    });

    profileMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const roleItem = e.target.closest('.profile-role-item');
      if (roleItem) {
        const newTarget = roleItem.dataset.user || roleItem.dataset.role;
        if (newTarget) updateRoleUI(newTarget);
        setMenuOpen(false);
        return;
      }
      const logoutItem = e.target.closest('#profile-menu-logout');
      if (logoutItem) {
        setMenuOpen(false);
        logout();
      }
    });

    // Close menu when clicking anywhere outside
    document.addEventListener('click', (e) => {
      if (!profileMenu.hidden && !e.target.closest('.global-profile-wrap')) {
        setMenuOpen(false);
      }
    });

    // Close menu on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !profileMenu.hidden) {
        setMenuOpen(false);
      }
    });
  }

  // Logout function
  const logout = () => {
    try {
      sessionStorage.removeItem('brass-auth');
      sessionStorage.removeItem('brass_in_map');
      sessionStorage.removeItem('brass_main_view');
    } catch (x) {}
    root.classList.remove('authed', 'in-map');
    document.getElementById('login-user').value = '';
    document.getElementById('login-pass').value = '';
    err.hidden = true;
    document.getElementById('login-user').focus();
    window.dispatchEvent(new Event('brass-logout'));
  };

  // Initialize role UI on load
  updateRoleUI(currentUser);
})();

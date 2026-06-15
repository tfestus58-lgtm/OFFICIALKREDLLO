/**
 * assets/shared.js
 * Kreddlo — Universal page script.
 * Loaded via <script src="/assets/shared.js"></script> in every page <head>.
 *
 * Responsibilities (in order):
 *   A. Favicon injection
 *   B. PWA manifest + Apple meta tags
 *   C. SEO config + applySEO()
 *   D. window.loadComponent()
 *   E. Auto component loading (navbar/footer or dashboard sidebar)
 *   F. Service worker registration
 *   G. FCM push token setup (dashboard pages only)
 *   H. Real-time notification bell dot (dashboard pages only)
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     A. FAVICON INJECTION
     Injects link tags before DOMContentLoaded — browsers pick
     them up even if injected slightly after parse.
  ══════════════════════════════════════════════════════════════ */
  (function injectFavicons() {
    const favicons = [
      { rel: 'icon',             type: 'image/x-icon', href: '/assets/favicon.ico' },
      { rel: 'icon',             type: 'image/png',    href: '/assets/favicon-32x32.png', sizes: '32x32' },
      { rel: 'icon',             type: 'image/png',    href: '/assets/favicon-16x16.png', sizes: '16x16' },
      { rel: 'apple-touch-icon', type: null,           href: '/assets/apple-touch-icon.png', sizes: '180x180' },
    ];

    favicons.forEach(function (f) {
      // Skip if already present (prevents duplicates on re-injection)
      if (document.querySelector('link[href="' + f.href + '"]')) return;
      var el = document.createElement('link');
      el.rel  = f.rel;
      if (f.type)  el.type  = f.type;
      if (f.sizes) el.sizes = f.sizes;
      el.href = f.href;
      document.head.appendChild(el);
    });
  })();


  /* ══════════════════════════════════════════════════════════════
     B. PWA MANIFEST + APPLE META TAGS
  ══════════════════════════════════════════════════════════════ */
  (function injectPWA() {
    function addLink(rel, href) {
      if (document.querySelector('link[rel="' + rel + '"]')) return;
      var el = document.createElement('link');
      el.rel  = rel;
      el.href = href;
      document.head.appendChild(el);
    }

    function addMeta(name, content) {
      if (document.querySelector('meta[name="' + name + '"]')) return;
      var el = document.createElement('meta');
      el.name    = name;
      el.content = content;
      document.head.appendChild(el);
    }

    addLink('manifest', '/manifest.json');
    addMeta('apple-mobile-web-app-capable',          'yes');
    addMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    addMeta('theme-color',                           '#0d2145');
  })();


  /* ══════════════════════════════════════════════════════════════
     C. SEO CONFIG + applySEO()
  ══════════════════════════════════════════════════════════════ */
  var PAGE_SEO = {
    '/':                  {
      title:       'Kreddlo - Global Freelance Payments for Verified Professionals',
      description: 'Kreddlo is a verified global freelance platform that gives professionals in underserved countries access to international payments, secure escrow and automatic payouts.',
      url:         'https://kreddlo.com/',
    },
    '/index.html':        {
      title:       'Kreddlo - Global Freelance Payments for Verified Professionals',
      description: 'Kreddlo is a verified global freelance platform that gives professionals in underserved countries access to international payments, secure escrow and automatic payouts.',
      url:         'https://kreddlo.com/',
    },
    '/browse.html':       {
      title:       'Browse Verified Freelancers - Kreddlo',
      description: 'Find skilled KYC-verified freelancers across design, development, writing, marketing and more. Every professional on Kreddlo is identity-verified.',
      url:         'https://kreddlo.com/browse.html',
    },
    '/pricing.html':      {
      title:       'Pricing and Fees - Kreddlo',
      description: 'Simple transparent pricing with no hidden fees. Understand exactly what freelancers and buyers pay before signing up on Kreddlo.',
      url:         'https://kreddlo.com/pricing.html',
    },
    '/how-it-works.html': {
      title:       'How Kreddlo Works - Verified Global Freelance Payments',
      description: 'Learn how Kreddlo connects KYC-verified freelancers with global clients using escrow, digital contracts and automatic crypto payouts.',
      url:         'https://kreddlo.com/how-it-works.html',
    },
    '/about.html':        {
      title:       'About Kreddlo - Built for Global Freelancers',
      description: 'Kreddlo was built to give talented freelancers in underserved countries the financial infrastructure and professional identity tools they deserve.',
      url:         'https://kreddlo.com/about.html',
    },
    '/privacy.html':      {
      title:       'Privacy Policy - Kreddlo',
      description: 'Learn how Kreddlo collects, uses and protects your personal data including identity verification documents and payment information.',
      url:         'https://kreddlo.com/privacy.html',
    },
    '/terms.html':        {
      title:       'Terms of Service - Kreddlo',
      description: 'Read the Kreddlo terms of service covering platform rules, fees, dispute resolution and user responsibilities.',
      url:         'https://kreddlo.com/terms.html',
    },
    '/signup.html':       {
      title:       'Create Your Account - Kreddlo',
      description: 'Sign up on Kreddlo to get verified and start working with global clients. Free to join for freelancers and buyers worldwide.',
      url:         'https://kreddlo.com/signup.html',
    },
    '/login.html':        {
      title:       'Log In - Kreddlo',
      description: 'Log in to your Kreddlo account to access your dashboard, contracts, earnings and withdrawal tools.',
      url:         'https://kreddlo.com/login.html',
    },
  };

  /**
   * Sets a meta tag's content by its element ID.
   * Falls back to querySelector by name/property if ID not found.
   */
  function setMeta(id, content, attr) {
    attr = attr || 'content';
    var el = document.getElementById(id);
    if (el) {
      el.setAttribute(attr, content);
    }
  }

  /**
   * window.applySEO(custom?)
   * Reads the current pathname, finds the matching PAGE_SEO entry,
   * optionally overrides with a custom object, then applies to the DOM.
   * Called automatically on every page load. Also exposed globally so
   * profile.html can call it with dynamic freelancer data after a
   * Firestore fetch.
   *
   * @param {Object} [custom] - optional override: { title, description, url }
   */
  function applySEO(custom) {
    var pathname = window.location.pathname;
    // Normalise trailing slash
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    var config = PAGE_SEO[pathname] || PAGE_SEO['/'];

    // Allow full override or partial override
    if (custom) {
      config = {
        title:       custom.title       || config.title,
        description: custom.description || config.description,
        url:         custom.url         || config.url,
      };
    }

    // document.title
    document.title = config.title;

    // Meta description
    setMeta('meta-description', config.description);

    // Open Graph
    setMeta('og-title',       config.title);
    setMeta('og-description', config.description);
    setMeta('og-url',         config.url);

    // Twitter
    setMeta('twitter-title',       config.title);
    setMeta('twitter-description', config.description);

    // Canonical
    setMeta('canonical', config.url, 'href');
  }

  // Expose globally for pages with dynamic SEO (e.g. profile.html)
  window.applySEO = applySEO;

  // Auto-apply on every page load
  applySEO();


  /* ══════════════════════════════════════════════════════════════
     D. window.loadComponent(targetId, filePath)
     Fetches an HTML partial and injects it into a target element.
     Also evaluates any <script> tags in the fetched HTML.
  ══════════════════════════════════════════════════════════════ */
  function loadComponent(targetId, filePath) {
    return fetch(filePath)
      .then(function (res) {
        if (!res.ok) {
          throw new Error('loadComponent: failed to fetch ' + filePath + ' (' + res.status + ')');
        }
        return res.text();
      })
      .then(function (html) {
        var target = document.getElementById(targetId);
        if (!target) {
          console.warn('loadComponent: element #' + targetId + ' not found on this page.');
          return;
        }
        target.innerHTML = html;

        // Re-execute any <script> tags in the injected HTML
        // (innerHTML does not execute scripts automatically)
        var scripts = target.querySelectorAll('script');
        scripts.forEach(function (oldScript) {
          var newScript = document.createElement('script');
          // Copy attributes (e.g. type, src)
          Array.from(oldScript.attributes).forEach(function (attr) {
            newScript.setAttribute(attr.name, attr.value);
          });
          newScript.textContent = oldScript.textContent;
          document.body.appendChild(newScript);
          oldScript.parentNode.removeChild(oldScript);
        });
      })
      .catch(function (err) {
        console.error(err.message);
      });
  }

  window.loadComponent = loadComponent;


  /* ══════════════════════════════════════════════════════════════
     E. AUTO COMPONENT LOADING
     Runs after DOMContentLoaded so placeholder elements exist.
     - Dashboard / buyer / admin / notifications pages:
         loads dashboard-sidebar.html → #sidebar-placeholder
         loads bottom-tab.html       → #bottom-tab-placeholder
     - All other pages:
         loads navbar.html  → #navbar-placeholder
         loads footer.html  → #footer-placeholder
  ══════════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', function () {

    var path = window.location.pathname.toLowerCase();

    var isDashboard = (
      path.includes('dashboard') ||
      path.includes('buyer')     ||
      path.includes('admin')     ||
      path.includes('notifications')
    );

    if (isDashboard) {
      // Dashboard layout components
      if (document.getElementById('sidebar-placeholder')) {
        loadComponent('sidebar-placeholder', '/components/dashboard-sidebar.html');
      }
      if (document.getElementById('bottom-tab-placeholder')) {
        loadComponent('bottom-tab-placeholder', '/components/bottom-tab.html');
      }
    } else {
      // Public page components
      if (document.getElementById('navbar-placeholder')) {
        loadComponent('navbar-placeholder', '/components/navbar.html');
      }
      if (document.getElementById('footer-placeholder')) {
        loadComponent('footer-placeholder', '/components/footer.html');
      }
    }

    /* ── F. SERVICE WORKER REGISTRATION ── */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js')
        .then(function (reg) {
          console.log('Kreddlo SW registered — scope:', reg.scope);
        })
        .catch(function (err) {
          console.warn('Kreddlo SW registration failed:', err.message);
        });
    }

    /* ── G + H. FCM + BELL DOT — dashboard pages only ── */
    if (isDashboard) {
      setupFCMAndBell();
    }

  });


  /* ══════════════════════════════════════════════════════════════
     G. FCM PUSH TOKEN SETUP
     Requests notification permission, gets the FCM token via
     window.firestore helpers (initialized in each page's <head>),
     compares with the stored token in Firestore, updates if changed.

     H. REAL-TIME NOTIFICATION BELL DOT
     Sets up a Firestore onSnapshot listener on the current user's
     notifications subcollection (unread only, limit 1).
     Shows/hides the red dot on #bell-dot in real time.
  ══════════════════════════════════════════════════════════════ */
  function setupFCMAndBell() {
    // Firebase is initialized in the page <head> and exposed on window.
    // We wait for auth state to confirm before touching Firestore.
    var authReady = setInterval(function () {
      if (
        typeof window.auth        === 'undefined' ||
        typeof window.authFn      === 'undefined' ||
        typeof window.db          === 'undefined' ||
        typeof window.firestore   === 'undefined'
      ) {
        return; // Firebase not ready yet — keep waiting
      }

      clearInterval(authReady);

      window.authFn.onAuthStateChanged(window.auth, function (user) {
        if (!user) return; // Not logged in — nothing to do

        var uid = user.uid;

        /* ── H. Bell dot listener ── */
        var notifQuery = window.firestore.query(
          window.firestore.collection(window.db, 'users', uid, 'notifications'),
          window.firestore.where('read', '==', false),
          window.firestore.limit(1)
        );

        window.firestore.onSnapshot(notifQuery, function (snapshot) {
          var bellDot = document.getElementById('bell-dot');
          if (!bellDot) return;
          bellDot.style.display = snapshot.empty ? 'none' : 'block';
        });

        /* ── G. FCM token setup ── */
        setupFCMToken(uid);
      });

    }, 100); // poll every 100ms until Firebase is ready
  }

  function setupFCMToken(uid) {
    // Only proceed if the browser supports notifications
    if (!('Notification' in window)) return;
    if (typeof window.messaging === 'undefined') return;

    var VAPID_KEY = typeof window.FIREBASE_VAPID_KEY !== 'undefined'
      ? window.FIREBASE_VAPID_KEY
      : ''; // Set window.FIREBASE_VAPID_KEY in the page <head> config block

    if (!VAPID_KEY) {
      console.warn('shared.js: FIREBASE_VAPID_KEY not set — skipping FCM token setup.');
      return;
    }

    Notification.requestPermission()
      .then(function (permission) {
        if (permission !== 'granted') {
          console.log('shared.js: Notification permission denied.');
          return;
        }

        return window.firestore.getToken(window.messaging, {
          vapidKey: VAPID_KEY,
        });
      })
      .then(function (newToken) {
        if (!newToken) return;

        // Compare with the stored token; only write if different
        return window.firestore.getDoc(
          window.firestore.doc(window.db, 'users', uid)
        ).then(function (snap) {
          var existingToken = snap.exists() ? (snap.data().fcmToken || '') : '';
          if (newToken === existingToken) return; // already up to date

          return window.firestore.setDoc(
            window.firestore.doc(window.db, 'users', uid),
            { fcmToken: newToken },
            { merge: true }
          ).then(function () {
            console.log('shared.js: FCM token updated in Firestore.');
          });
        });
      })
      .catch(function (err) {
        // Non-fatal — never interrupt the page
        console.warn('shared.js: FCM token setup failed:', err.message);
      });
  }

})(); // end IIFE

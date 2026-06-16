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
    '/': {
      title:       'Kreddlo - Global Freelance Payments for Verified Professionals',
      description: 'Kreddlo is the Fiverr and Upwork alternative built for global freelancers. Unlike Selar, Gumroad or Payhip, Kreddlo combines KYC verification, escrow contracts and automatic payouts — better than Payoneer or Wise for freelance income.',
      url:         'https://kreddlo.com/',
      type:        'website',
    },
    '/index.html': {
      title:       'Kreddlo - Global Freelance Payments for Verified Professionals',
      description: 'Kreddlo is the Fiverr and Upwork alternative built for global freelancers. Unlike Selar, Gumroad or Payhip, Kreddlo combines KYC verification, escrow contracts and automatic payouts — better than Payoneer or Wise for freelance income.',
      url:         'https://kreddlo.com/',
      type:        'website',
    },
    '/browse.html': {
      title:       'Browse Verified Freelancers - Kreddlo',
      description: 'Find KYC-verified freelancers across design, development, writing and marketing. A trusted Fiverr and Upwork alternative where every professional is identity-verified and paid faster than Payoneer, Wise or Paystack.',
      url:         'https://kreddlo.com/browse.html',
      type:        'website',
    },
    '/pricing.html': {
      title:       'Pricing and Fees - Kreddlo',
      description: 'Simple transparent pricing — lower fees than Fiverr, Upwork and Selar. No hidden charges like Payoneer or Wise. See exactly what freelancers and buyers pay. A fairer alternative to Flutterwave and Paystack for service payments.',
      url:         'https://kreddlo.com/pricing.html',
      type:        'website',
    },
    '/how-it-works.html': {
      title:       'How Kreddlo Works - Verified Global Freelance Payments',
      description: 'Kreddlo connects KYC-verified freelancers with global clients using escrow, digital contracts and automatic payouts. A better alternative to Fiverr, Upwork, Geegpay and Grey for professionals in underserved countries.',
      url:         'https://kreddlo.com/how-it-works.html',
      type:        'website',
    },
    '/about.html': {
      title:       'About Kreddlo - Built for Global Freelancers',
      description: 'Kreddlo was built to give talented freelancers the tools Fiverr, Upwork, Selar and Nestuge never provided — KYC-verified identity, escrow protection and payouts that work where Payoneer, Wise, Geegpay and Grey fall short.',
      url:         'https://kreddlo.com/about.html',
      type:        'website',
    },
    '/privacy.html': {
      title:       'Privacy Policy - Kreddlo',
      description: 'Learn how Kreddlo collects, uses and protects your personal data including identity verification documents and payment information.',
      url:         'https://kreddlo.com/privacy.html',
      type:        'website',
    },
    '/terms.html': {
      title:       'Terms of Service - Kreddlo',
      description: 'Read the Kreddlo terms of service covering platform rules, fees, dispute resolution and user responsibilities.',
      url:         'https://kreddlo.com/terms.html',
      type:        'website',
    },
    '/signup.html': {
      title:       'Create Your Free Account - Kreddlo',
      description: 'Join Kreddlo free and get verified to work with global clients. Get paid faster than Fiverr, Upwork, Selar or Selfany — without the payout limits of Payoneer, Wise, Flutterwave or Paystack.',
      url:         'https://kreddlo.com/signup.html',
      type:        'website',
    },
    '/login.html': {
      title:       'Log In - Kreddlo',
      description: 'Log in to your Kreddlo account to access your dashboard, contracts, earnings and withdrawal tools.',
      url:         'https://kreddlo.com/login.html',
      type:        'website',
    },
    '/store.html': {
      title:       'My Service Store - Kreddlo',
      description: 'Showcase and sell your freelance services on Kreddlo. A verified store that works better than Selar, Selfany or Nestuge — with built-in escrow, contracts and global client discovery.',
      url:         'https://kreddlo.com/store.html',
      type:        'website',
    },
    '/p.html': {
      title:       'Service Listing - Kreddlo',
      description: 'View this verified freelance service on Kreddlo. Hire a KYC-verified professional with secure escrow and guaranteed payouts — no Payoneer, Wise or Flutterwave limits.',
      url:         'https://kreddlo.com/p.html',
      type:        'product',
    },
    '/review.html': {
      title:       'Leave a Review - Kreddlo',
      description: 'Share your experience working with a Kreddlo freelancer. Your review helps build trust across the global freelance community.',
      url:         'https://kreddlo.com/review.html',
      type:        'website',
    },
    '/profile.html': {
      title:       'Freelancer Profile - Kreddlo',
      description: 'View this verified freelancer\'s profile on Kreddlo. Browse their portfolio, services and reviews. Hire with confidence using secure escrow — the better alternative to Fiverr and Upwork.',
      url:         'https://kreddlo.com/profile.html',
      type:        'profile',
    },
  };

  // Default OG image — create a 1200×630 branded image and host at this path.
  // Until then social shares will show no image; any image is better than none.
  var DEFAULT_OG_IMAGE = 'https://kreddlo.com/assets/og-image.png';

  /**
   * Sets a <meta> tag content by element ID.
   */
  function setMeta(id, content, attr) {
    attr = attr || 'content';
    var el = document.getElementById(id);
    if (el) el.setAttribute(attr, content);
  }

  /**
   * Upserts a <meta> tag by property or name attribute.
   * Creates it if it does not already exist in <head>.
   */
  function upsertMeta(attrName, attrValue, content) {
    var sel = 'meta[' + attrName + '="' + attrValue + '"]';
    var el = document.querySelector(sel);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attrName, attrValue);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  }

  /**
   * Injects or replaces the JSON-LD <script> block for structured data.
   * Google and AI crawlers read this first — it is the highest-value SEO tag.
   */
  function injectJSONLD(data) {
    var existing = document.getElementById('kreddlo-jsonld');
    if (existing) existing.parentNode.removeChild(existing);
    var script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id   = 'kreddlo-jsonld';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
  }

  /**
   * window.applySEO(custom?)
   * Reads the current pathname, finds the matching PAGE_SEO entry,
   * optionally overrides with a custom object, then applies to the DOM.
   * Called automatically on every page load. Also exposed globally so
   * profile.html can call it with dynamic freelancer data after a
   * Firestore fetch.
   *
   * @param {Object} [custom] - optional override:
   *   { title, description, url, image, type, jsonld }
   *   - image:  full URL to a 1200×630 image (overrides DEFAULT_OG_IMAGE)
   *   - type:   og:type string e.g. 'profile', 'product', 'website'
   *   - jsonld: a ready-made JSON-LD object (skips auto-generation)
   */
  function applySEO(custom) {
    var pathname = window.location.pathname;
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    var base = PAGE_SEO[pathname] || PAGE_SEO['/'];

    var config = {
      title:       (custom && custom.title)       || base.title,
      description: (custom && custom.description) || base.description,
      url:         (custom && custom.url)         || base.url,
      image:       (custom && custom.image)       || DEFAULT_OG_IMAGE,
      type:        (custom && custom.type)        || base.type  || 'website',
      jsonld:      (custom && custom.jsonld)      || null,
    };

    /* ── 1. document.title ── */
    document.title = config.title;

    /* ── 2. Meta description (ID-based, already in <head>) ── */
    setMeta('meta-description', config.description);

    /* ── 3. Open Graph — upsert so missing tags are created automatically ── */
    upsertMeta('property', 'og:title',       config.title);
    upsertMeta('property', 'og:description', config.description);
    upsertMeta('property', 'og:url',         config.url);
    upsertMeta('property', 'og:type',        config.type);
    upsertMeta('property', 'og:image',       config.image);
    upsertMeta('property', 'og:image:width',  '1200');
    upsertMeta('property', 'og:image:height', '630');
    upsertMeta('property', 'og:site_name',   'Kreddlo');

    /* ── 4. Twitter Card ── */
    upsertMeta('name', 'twitter:card',        'summary_large_image');
    upsertMeta('name', 'twitter:site',        '@kreddlo');
    upsertMeta('name', 'twitter:title',       config.title);
    upsertMeta('name', 'twitter:description', config.description);
    upsertMeta('name', 'twitter:image',       config.image);

    /* ── 5. Canonical ── */
    setMeta('canonical', config.url, 'href');

    /* ── 6. JSON-LD structured data ── */
    var jsonld = config.jsonld;

    if (!jsonld) {
      // Auto-generate appropriate schema based on page type
      if (config.type === 'profile' && custom && custom.name) {
        // Freelancer profile page — Person + ProfilePage schema
        jsonld = {
          '@context': 'https://schema.org',
          '@type':    'ProfilePage',
          'name':     config.title,
          'url':      config.url,
          'mainEntity': {
            '@type':       'Person',
            'name':        custom.name,
            'url':         config.url,
            'description': config.description,
            'image':       config.image,
            'worksFor': {
              '@type': 'Organization',
              'name':  'Kreddlo',
              'url':   'https://kreddlo.com',
            },
          },
        };
      } else if (config.type === 'product' && custom && custom.name) {
        // Service/product listing page
        jsonld = {
          '@context':   'https://schema.org',
          '@type':      'Service',
          'name':        custom.name || config.title,
          'description': config.description,
          'url':         config.url,
          'image':       config.image,
          'provider': {
            '@type': 'Organization',
            'name':  'Kreddlo',
            'url':   'https://kreddlo.com',
          },
        };
      } else {
        // Default: WebSite + Organization for public pages
        jsonld = {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebSite',
              '@id':   'https://kreddlo.com/#website',
              'url':   'https://kreddlo.com',
              'name':  'Kreddlo',
              'description': 'Global verified freelance marketplace and payment platform',
              'potentialAction': {
                '@type':       'SearchAction',
                'target':      'https://kreddlo.com/browse.html?q={search_term_string}',
                'query-input': 'required name=search_term_string',
              },
            },
            {
              '@type':       'Organization',
              '@id':         'https://kreddlo.com/#organization',
              'name':        'Kreddlo',
              'url':         'https://kreddlo.com',
              'logo':        'https://kreddlo.com/assets/logo.png',
              'description': 'Kreddlo is a verified global freelance marketplace and payment platform — the Fiverr and Upwork alternative for professionals in underserved countries.',
              'sameAs': [
                'https://twitter.com/kreddlo',
              ],
            },
            {
              '@type':           'WebPage',
              '@id':             config.url + '#webpage',
              'url':             config.url,
              'name':            config.title,
              'description':     config.description,
              'isPartOf':        { '@id': 'https://kreddlo.com/#website' },
              'inLanguage':      'en',
            },
          ],
        };
      }
    }

    injectJSONLD(jsonld);
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
     window.fs* helpers (exposed from each page's module script),
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
        typeof window.auth === 'undefined' ||
        typeof window.db   === 'undefined'
      ) {
        return; // Firebase not ready yet — keep waiting
      }

      clearInterval(authReady);
      clearTimeout(authReadyBailout);

      window.onAuthStateChanged(window.auth, function (user) {
        if (!user) return; // Not logged in — nothing to do

        var uid = user.uid;

        /* ── H. Bell dot listener ── */
        var notifQuery = window.fsQuery(
          window.fsCollection(window.db, 'users', uid, 'notifications'),
          window.fsWhere('read', '==', false),
          window.fsLimit(1)
        );

        window.fsOnSnapshot(notifQuery, function (snapshot) {
          var bellDot = document.getElementById('bell-dot');
          if (!bellDot) return;
          bellDot.style.display = snapshot.empty ? 'none' : 'block';
        });

        /* ── G. FCM token setup ── */
        setupFCMToken(uid);
      });

    }, 100); // poll every 100ms until Firebase is ready

    // Bail out after 10 s — prevents infinite loop if Firebase never initialises
    var authReadyBailout = setTimeout(function () {
      clearInterval(authReady);
      console.warn('shared.js: Firebase not ready after 10 s — bell dot and FCM skipped.');
    }, 10000);
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

        return window.fsGetToken(window.messaging, {
          vapidKey: VAPID_KEY,
        });
      })
      .then(function (newToken) {
        if (!newToken) return;

        // Compare with the stored token; only write if different
        return window.fsGetDoc(
          window.fsDoc(window.db, 'users', uid)
        ).then(function (snap) {
          var existingToken = snap.exists() ? (snap.data().fcmToken || '') : '';
          if (newToken === existingToken) return; // already up to date

          return window.fsSetDoc(
            window.fsDoc(window.db, 'users', uid),
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

// ── Centralised VAPID public key ─────────────────────────────────────────────
// Used by dashboard.html and dashboard-settings.html for FCM push notifications.
// Source: Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
window.KREDDLO_VAPID_PUBLIC_KEY = 'BAMBTh5A3sX4MsxQD1xlJwgLrFR9bYs-IXJ4Xoq-Orn1gByn81_qvD2lTtbkM1R328JqXe63veD3fyK1ulPDb1c';

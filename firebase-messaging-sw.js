importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// PWA lifecycle — unified service worker (replaces sw.js)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
// No fetch interception — live data must always go to network

// Firebase config — must match index.html
// Fill in from Firebase Console: Project Settings → Your Apps → Web app
firebase.initializeApp({
  apiKey:            'FILL_IN_FROM_FIREBASE_CONSOLE',
  authDomain:        'business-smoothie-portal.firebaseapp.com',
  projectId:         'business-smoothie-portal',
  storageBucket:     'business-smoothie-portal.firebasestorage.app',
  messagingSenderId: 'FILL_IN_FROM_FIREBASE_CONSOLE',
  appId:             'FILL_IN_FROM_FIREBASE_CONSOLE'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const notification = payload.notification || {};
  self.registration.showNotification(notification.title || 'Business Smoothie Portal', {
    body:  notification.body || '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data:  { url: 'https://portal.businesssmoothie.com' }
  });
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://portal.businesssmoothie.com';
  event.waitUntil(clients.openWindow(url));
});

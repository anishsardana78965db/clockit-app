// ClockIt — FCM service worker. Displays push notifications when the app
// is closed. Must live at the site root. Config selection mirrors index.html.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

const PRODUCTION_CONFIG = {
  apiKey: "AIzaSyASxUgNv56ayeCNH9niYcSyY9TRlYsWap4",
  authDomain: "attendance-2d879.firebaseapp.com",
  projectId: "attendance-2d879",
  storageBucket: "attendance-2d879.firebasestorage.app",
  messagingSenderId: "878446144077",
  appId: "1:878446144077:web:579f0befe06849cd5aca04"
};

const STAGING_CONFIG = {
  apiKey: "AIzaSyCcaMVGGahe87Tq7L39KYmVftP9taU-jIQ",
  authDomain: "testclockit-8283d.firebaseapp.com",
  projectId: "testclockit-8283d",
  storageBucket: "testclockit-8283d.firebasestorage.app",
  messagingSenderId: "659613699389",
  appId: "1:659613699389:web:01f596c14a0bb568084954"
};

firebase.initializeApp(
  self.location.hostname === "clockit-wot.pages.dev" ? PRODUCTION_CONFIG : STAGING_CONFIG
);

// Notification-type messages are displayed automatically by the SDK;
// instantiating messaging wires up the background handler.
firebase.messaging();

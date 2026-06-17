// ============================================================
//  MyLife Notes — Firebase configuration
// ============================================================
//  LEAVE THIS AS-IS to run in LOCAL MODE (data saved only on
//  this device's browser — great for trying the app out).
//
//  To sync across your phone + laptop and get real password
//  reset emails, paste your Firebase web config below and set
//  ENABLED = true. Setup steps are in README.md.
// ============================================================

export const FIREBASE = {
  ENABLED: false,

  config: {
    apiKey: "PASTE_API_KEY",
    authDomain: "PASTE_PROJECT.firebaseapp.com",
    projectId: "PASTE_PROJECT_ID",
    storageBucket: "PASTE_PROJECT.appspot.com",
    messagingSenderId: "PASTE_SENDER_ID",
    appId: "PASTE_APP_ID"
  }
};

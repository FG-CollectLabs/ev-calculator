// Firebase Google OAuth guard.
// Checks authentication on every page load. Only allows ALLOWED_EMAILS.
// Config injected by Hugo via window.FG_FIREBASE_CONFIG.
(function () {
  const ALLOWED_EMAILS = ["nguye208@gmail.com"];

  const cfg = window.FG_FIREBASE_CONFIG;
  if (!cfg) return; // no config = dev mode, skip auth

  // Dynamically load Firebase SDK modules then run auth check.
  async function boot() {
    const { initializeApp }          = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut }
                                      = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");

    const app      = initializeApp(cfg);
    const auth     = getAuth(app);
    const provider = new GoogleAuthProvider();

    // Build login overlay.
    const overlay = document.createElement("div");
    overlay.id = "auth-overlay";
    overlay.style.cssText = [
      "position:fixed;inset:0;z-index:9999",
      "background:var(--bg,#0f1115)",
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.5rem",
      "font-family:inherit",
    ].join(";");
    overlay.innerHTML = `
      <div style="font-size:1.4rem;font-weight:700;color:var(--fg,#e6e7ea)">FG CollectLabs</div>
      <div id="auth-msg" style="color:var(--muted,#8b8f99);font-size:0.95rem">Sign in to continue</div>
      <button id="auth-btn" style="
        background:var(--accent,#6ea8fe);color:#0f1115;border:none;border-radius:8px;
        padding:0.6rem 1.4rem;font-size:1rem;font-weight:600;cursor:pointer">
        Sign in with Google
      </button>`;

    function showOverlay(msg) {
      document.getElementById("auth-msg").textContent = msg || "Sign in to continue";
      if (!document.getElementById("auth-overlay")) {
        document.body.appendChild(overlay);
      }
    }
    function hideOverlay() {
      overlay.remove();
    }

    document.getElementById("auth-btn").addEventListener("click", async () => {
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        showOverlay("Sign-in failed — " + e.message);
      }
    });

    onAuthStateChanged(auth, user => {
      if (!user) {
        showOverlay("Sign in to continue");
        return;
      }
      if (!ALLOWED_EMAILS.includes(user.email)) {
        showOverlay("Access denied: " + user.email);
        signOut(auth);
        return;
      }
      hideOverlay();
    });
  }

  boot().catch(console.error);
})();

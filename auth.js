import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/13.4.0";
const SYNC_INTERVAL_MS = 10000;
const RETURN_TO_KEY = "authReturnTo";
// Remembers which account the progress in this browser belongs to.
const PROGRESS_OWNER_KEY = "progressOwner";

const AUTH_ERRORS = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/missing-email": "Enter your email address.",
    "auth/missing-password": "Enter your password.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/email-already-in-use": "An account with this email already exists. Log in instead.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/invalid-login-credentials": "Incorrect email or password.",
    "auth/wrong-password": "Incorrect email or password.",
    "auth/user-not-found": "Incorrect email or password.",
    "auth/user-disabled": "This account has been disabled.",
    "auth/too-many-requests": "Too many attempts. Please wait a bit and try again.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/popup-blocked": "Your browser blocked the Google sign-in popup. Allow popups for this site and try again.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/cancelled-popup-request": "Google sign-in was cancelled.",
    "auth/account-exists-with-different-credential": "This email is already registered with a different sign-in method.",
    "auth/unauthorized-domain": "This website isn't authorised for sign-in yet (Firebase → Authentication → Settings → Authorized domains).",
    "auth/operation-not-allowed": "This sign-in method isn't enabled in Firebase yet.",
    "permission-denied": "Your saved progress couldn't be accessed (check the Firestore security rules).",
    "unavailable": "Couldn't reach the server. Check your connection and try again."
};

const grimoire = window.Grimoire;
const loginBtn = document.getElementById("login-btn");
const userMenu = document.getElementById("user-menu");
const userEmailEl = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");
const authCard = document.querySelector(".auth-card");
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const loginMessage = document.getElementById("login-message");
const signupMessage = document.getElementById("signup-message");

let fbAuth = null;
let fbStore = null;
let auth = null;
let db = null;
let sessionUid = null;
let authActionInProgress = false;
let syncInProgress = false;
let hasUnsyncedChanges = false;
let lastPushFailed = false;
let pushTimer = null;

function isConfigured(config) {
    return Boolean(config && config.apiKey && config.projectId
        && !config.apiKey.startsWith("YOUR_") && !config.projectId.startsWith("YOUR_"));
}

function friendlyError(err) {
    return AUTH_ERRORS[err && err.code] || "Something went wrong. Please try again.";
}

function setMessage(el, text, isError = false) {
    el.textContent = text;
    el.classList.toggle("error", isError);
}

function setBusy(busy) {
    authCard.classList.toggle("busy", busy);
}

function showUnavailable() {
    authCard.classList.add("unavailable");
    document.getElementById("auth-unavailable").hidden = false;
}

function updateHeader(user) {
    loginBtn.hidden = Boolean(user);
    userMenu.hidden = !user;
    const label = user ? (user.email || user.displayName || "Signed in") : "";
    userEmailEl.textContent = label;
    userEmailEl.title = label;
}

function goBackAfterAuth() {
    const saved = sessionStorage.getItem(RETURN_TO_KEY) || "#/";
    sessionStorage.removeItem(RETURN_TO_KEY);
    // Send readers to the novel page so "Continue Reading" reflects the loaded progress.
    grimoire.navigate(saved.replace(/^(#\/novel\/[^/]+)\/chapter\/.*$/, "$1"), true);
}

/* ---------- Progress sync ---------- */

function userDocRef(uid) {
    return fbStore.doc(db, "users", uid);
}

function schedulePush() {
    hasUnsyncedChanges = true;
    if (!sessionUid || pushTimer || syncInProgress) return;
    pushTimer = setTimeout(pushNow, SYNC_INTERVAL_MS);
}

async function pushNow() {
    if (!sessionUid) return false;
    grimoire.flushScrollSave();
    clearTimeout(pushTimer);
    pushTimer = null;

    const uid = sessionUid;
    const updatedAtMs = grimoire.ensureProgressTimestamp();
    hasUnsyncedChanges = false;
    try {
        await fbStore.setDoc(userDocRef(uid), {
            progress: grimoire.collectProgress(),
            updatedAtMs,
            updatedAt: fbStore.serverTimestamp()
        });
        localStorage.setItem(PROGRESS_OWNER_KEY, uid);
        lastPushFailed = false;
        return true;
    } catch (err) {
        console.error(err);
        hasUnsyncedChanges = true;
        if (!lastPushFailed) grimoire.showToast("Couldn't save progress to your account. Retrying…", true);
        lastPushFailed = true;
        if (sessionUid === uid && !pushTimer) pushTimer = setTimeout(pushNow, SYNC_INTERVAL_MS * 3);
        return false;
    }
}

// mode "explicit": user just logged in / signed up → account progress wins; a brand-new account gets this browser's progress.
// mode "restore": already signed in (page load / tab refocus) → whichever side changed most recently wins.
async function startSession(user, mode) {
    const snapshot = await fbStore.getDoc(userDocRef(user.uid));
    sessionUid = user.uid;

    if (!snapshot.exists()) {
        await pushNow();
        return "saved";
    }

    const cloud = snapshot.data();
    const cloudUpdatedAt = Number(cloud.updatedAtMs) || 0;
    const ownsLocal = localStorage.getItem(PROGRESS_OWNER_KEY) === user.uid;
    const localUpdatedAt = grimoire.getLocalProgressUpdatedAt();

    if (mode === "restore" && ownsLocal) {
        if (localUpdatedAt > cloudUpdatedAt) {
            await pushNow();
            return "saved";
        }
        if (localUpdatedAt === cloudUpdatedAt) return "unchanged";
    }

    clearTimeout(pushTimer);
    pushTimer = null;
    hasUnsyncedChanges = false;
    grimoire.applyProgress(cloud.progress || {}, cloudUpdatedAt);
    localStorage.setItem(PROGRESS_OWNER_KEY, user.uid);
    return "loaded";
}

async function runSync(user, mode) {
    if (syncInProgress) return null;
    syncInProgress = true;
    try {
        return await startSession(user, mode);
    } finally {
        syncInProgress = false;
        if (sessionUid && hasUnsyncedChanges) schedulePush();
    }
}

async function handleAuthStateChanged(user) {
    updateHeader(user);
    if (!user) {
        sessionUid = null;
        return;
    }
    if (authActionInProgress || sessionUid === user.uid) return;

    try {
        await runSync(user, "restore");
    } catch (err) {
        console.error(err);
        grimoire.showToast(`Couldn't load your saved progress. ${friendlyError(err)}`, true);
    }
    if (document.getElementById("auth-view").classList.contains("active")) goBackAfterAuth();
}

/* ---------- Login / signup / logout ---------- */

async function runAuthAction(messageEl, signIn) {
    if (!auth) {
        setMessage(messageEl, "Still connecting. Please try again in a moment.", true);
        return;
    }
    setBusy(true);
    setMessage(messageEl, "");
    authActionInProgress = true;
    try {
        const credential = await signIn();
        const result = await runSync(credential.user, "explicit");
        grimoire.showToast(result === "loaded"
            ? "Logged in. Your saved progress has been loaded."
            : "Signed in. Your reading progress is now saved to your account.");
        loginForm.reset();
        signupForm.reset();
        goBackAfterAuth();
    } catch (err) {
        console.error(err);
        setMessage(messageEl, friendlyError(err), true);
        if (auth.currentUser && sessionUid !== auth.currentUser.uid) {
            await fbAuth.signOut(auth).catch(() => {});
        }
    } finally {
        authActionInProgress = false;
        setBusy(false);
    }
}

loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    if (!email || !password) {
        setMessage(loginMessage, "Enter your email and password.", true);
        return;
    }
    runAuthAction(loginMessage, () => fbAuth.signInWithEmailAndPassword(auth, email, password));
});

signupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    const confirmPassword = document.getElementById("signup-confirm").value;
    if (!email || !password) {
        setMessage(signupMessage, "Enter an email and a password.", true);
        return;
    }
    if (password.length < 6) {
        setMessage(signupMessage, "Password must be at least 6 characters.", true);
        return;
    }
    if (password !== confirmPassword) {
        setMessage(signupMessage, "Passwords don't match.", true);
        return;
    }
    runAuthAction(signupMessage, () => fbAuth.createUserWithEmailAndPassword(auth, email, password));
});

document.querySelectorAll("[data-google-signin]").forEach(btn => {
    btn.addEventListener("click", () => {
        const messageEl = btn.closest(".auth-panel").querySelector(".auth-message");
        // signInWithPopup must start synchronously inside the click so browsers don't block the popup.
        runAuthAction(messageEl, () => fbAuth.signInWithPopup(auth, new fbAuth.GoogleAuthProvider()));
    });
});

document.getElementById("forgot-password-btn").addEventListener("click", async () => {
    const emailInput = document.getElementById("login-email");
    const email = emailInput.value.trim();
    if (!email) {
        setMessage(loginMessage, "Enter your email above, then click “Forgot password?” again.", true);
        emailInput.focus();
        return;
    }
    if (!auth) {
        setMessage(loginMessage, "Still connecting. Please try again in a moment.", true);
        return;
    }
    setBusy(true);
    try {
        await fbAuth.sendPasswordResetEmail(auth, email);
        setMessage(loginMessage, "If an account exists for that email, a password reset link is on its way.");
    } catch (err) {
        setMessage(loginMessage, friendlyError(err), true);
    } finally {
        setBusy(false);
    }
});

loginBtn.addEventListener("click", () => {
    const current = location.hash || "#/";
    if (!/^#\/(login|signup)\b/.test(current)) sessionStorage.setItem(RETURN_TO_KEY, current);
    grimoire.navigate("#/login");
});

logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
        grimoire.flushScrollSave();
        if (hasUnsyncedChanges && !(await pushNow())) {
            if (!confirm("Your latest progress couldn't be saved to your account. Log out anyway?")) return;
        }
        sessionUid = null;
        clearTimeout(pushTimer);
        pushTimer = null;
        hasUnsyncedChanges = false;
        await fbAuth.signOut(auth);
        // The account keeps the progress; clear this browser so the next reader starts fresh.
        localStorage.removeItem(PROGRESS_OWNER_KEY);
        grimoire.clearProgress();
        grimoire.showToast("Logged out. Your progress is saved in your account.");
    } catch (err) {
        console.error(err);
        grimoire.showToast(friendlyError(err), true);
    } finally {
        logoutBtn.disabled = false;
    }
});

window.addEventListener("grimoire:auth-view", () => {
    setMessage(loginMessage, "");
    setMessage(signupMessage, "");
    if (auth && auth.currentUser && sessionUid) setTimeout(goBackAfterAuth, 0);
});

window.addEventListener("grimoire:progress-changed", schedulePush);

document.addEventListener("visibilitychange", () => {
    if (!auth || !auth.currentUser) return;
    if (document.hidden) {
        if (sessionUid && hasUnsyncedChanges) pushNow();
        return;
    }
    // Back on this tab: pick up progress made on another device in the meantime.
    runSync(auth.currentUser, "restore")
        .then(result => {
            if (result === "loaded") grimoire.showToast("Progress updated from your other device.");
        })
        .catch(err => console.error(err));
});

window.addEventListener("pagehide", () => {
    if (sessionUid && hasUnsyncedChanges) pushNow();
});

async function start() {
    const [appModule, authModule, storeModule] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`),
        import(`${FIREBASE_SDK}/firebase-auth.js`),
        import(`${FIREBASE_SDK}/firebase-firestore.js`)
    ]);
    fbAuth = authModule;
    fbStore = storeModule;
    const app = appModule.initializeApp(firebaseConfig);
    auth = fbAuth.getAuth(app);
    db = fbStore.getFirestore(app);

    fbAuth.onAuthStateChanged(auth, (user) => {
        handleAuthStateChanged(user).catch(err => console.error(err));
    });
}

if (!grimoire) {
    console.error("auth.js: app.js did not load, account features disabled.");
} else if (!isConfigured(firebaseConfig)) {
    showUnavailable();
} else {
    start().catch((err) => {
        console.error(err);
        showUnavailable();
    });
}

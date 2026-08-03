// Firebase wrapper: auth (PIN-based), Firestore (state cache + onSnapshot).
// No Firebase Storage — item/routine photos are compressed client-side (see
// fileToCompressedDataUrl in app.js) and stored as base64 data URLs directly
// in Firestore docs, since Storage now requires the paid Blaze plan even for
// tiny usage. Loaded after firebase-config.js and the Firebase compat SDK
// <script> tags, before app.js.

firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const firestore = firebase.firestore();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

const EMAIL_DOMAIN = 'didi-malatang.local';
const OWNER_EMAIL = `owner@${EMAIL_DOMAIN}`;

function slugify(name) {
  const ascii = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  if (ascii) return ascii;
  // Names with no ASCII letters/digits at all (e.g. Thai-only names) used to
  // all fall back to the same literal 'user' slug, so the second Thai-named
  // account ever created would collide with the first on the same login
  // email and fail outright — permanently, once the first is deleted, since
  // removing a staff doc doesn't delete the orphaned Auth login (see
  // CLAUDE.md). Encode every character's code point instead so distinct
  // names always produce distinct, but still deterministic, ASCII slugs.
  const codePoints = Array.from(String(name).trim()).map((ch) => ch.codePointAt(0).toString(36));
  return codePoints.length ? `u-${codePoints.join('')}` : 'user';
}

function emailForName(name) {
  return `${slugify(name)}@${EMAIL_DOMAIN}`;
}

const DB = {
  OWNER_EMAIL,

  uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  },

  // Auth: "name" of 'owner' (case-insensitive) maps to the bootstrap Owner
  // account so the shop can never get locked out even before any staff
  // Firestore doc exists.
  async login(name, pin) {
    const email = name.trim().toLowerCase() === 'owner' ? OWNER_EMAIL : emailForName(name);
    const credential = await auth.signInWithEmailAndPassword(email, pin);
    return credential.user;
  },

  async logout() {
    await auth.signOut();
  },

  onAuthChange(callback) {
    return auth.onAuthStateChanged(callback);
  },

  // Creates a new Auth login for a staff member without signing out the
  // admin/manager currently doing the creating: done on a throwaway secondary
  // Firebase App instance, which is torn down immediately after.
  async createStaffAuthAccount(name, pin) {
    const secondaryApp = firebase.initializeApp(window.FIREBASE_CONFIG, `secondary-${Date.now()}`);
    try {
      const credential = await secondaryApp.auth().createUserWithEmailAndPassword(emailForName(name), pin);
      return credential.user.uid;
    } finally {
      await secondaryApp.auth().signOut();
      await secondaryApp.delete();
    }
  },

  // Self-service PIN change for whoever is currently signed in. Firebase
  // requires "recent login" for a sensitive op like updatePassword, so this
  // re-authenticates with the current PIN first rather than assuming the
  // existing session is fresh enough — a session that's been open a while
  // would otherwise fail with auth/requires-recent-login.
  async changePassword(currentPin, newPin) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error('ไม่พบผู้ใช้ที่เข้าสู่ระบบ');
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPin);
    await user.reauthenticateWithCredential(credential);
    await user.updatePassword(newPin);
  },

  watch(collection, callback) {
    return firestore.collection(collection).onSnapshot(
      (snapshot) => {
        callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      },
      (error) => console.error(`watch(${collection}) failed`, error)
    );
  },

  // notifications grows forever (nearly every mutation in the app pushes one,
  // nothing ever deletes old ones) — watching the whole collection re-reads
  // every doc in it on every app open. This scopes the live listener to just
  // the most recent `limit`, which is also all renderNotifications actually
  // displays without pagination. Older history is reachable on demand via
  // getOlderNotifications below, as a one-time (non-live) read.
  watchRecentNotifications(callback, limit = 50) {
    return firestore
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .onSnapshot(
        (snapshot) => {
          callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        },
        (error) => console.error('watchRecentNotifications failed', error)
      );
  },

  // One-time (not live) page of older notifications, for the "โหลดเพิ่มเติม"
  // button — deliberately a plain .get() rather than another onSnapshot,
  // since adding more live listeners the longer someone stays on the page
  // would defeat the point of limiting the main watcher above.
  async getOlderNotifications(beforeCreatedAt, limit = 50) {
    const snapshot = await firestore
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .startAfter(beforeCreatedAt)
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  },

  async getOnce(collection, id) {
    const doc = await firestore.collection(collection).doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },

  // record.id is required (callers generate it via DB.uid or a deterministic
  // key like `${date}_${staffId}`) so writes double as upserts.
  async put(collection, record) {
    const { id, ...data } = record;
    await firestore.collection(collection).doc(id).set(data, { merge: true });
    return id;
  },

  async del(collection, id) {
    await firestore.collection(collection).doc(id).delete();
  }
};

window.DB = DB;
window.emailForName = emailForName;

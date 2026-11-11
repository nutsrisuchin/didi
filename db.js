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

// Offline persistence: cache every doc this device has already seen in
// IndexedDB, so on the next open each onSnapshot listener fires immediately
// from the local cache instead of leaving the UI empty until the first
// network round-trip returns (views render from `state`, which starts empty,
// so a cold Firestore connection reads as "the app is slow"). The server
// snapshot still arrives right after and overwrites anything that changed,
// so this only changes how fast the *first* paint happens.
// Must be called before any other Firestore use — hence here, at load, before
// DB.watch/DB.put can run. It rejects rather than throwing synchronously, and
// both documented failure modes are non-fatal: 'failed-precondition' (another
// tab already holds the cache lease — rare with synchronizeTabs, but possible)
// and 'unimplemented' (no usable IndexedDB, e.g. iOS Safari private browsing).
// In either case Firestore keeps working exactly as before, just uncached, so
// log and carry on rather than blocking login on it.
firestore.enablePersistence({ synchronizeTabs: true }).catch((error) => {
  console.warn('Firestore offline persistence unavailable', error && error.code, error);
});

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

  // duties is a per-day-per-person grid, so it grows at exactly the rate
  // attendance does — headcount x ~30 docs every month, forever. Unlike
  // attendance, though, nothing in the app ever needs two months of it at
  // once (renderFinancial reads the previous month of attendance for its
  // comparison card; the duty roster has no such view), so this watcher is
  // scoped to the single month on screen from the start rather than
  // watching the whole collection and re-reading every month ever recorded
  // on every app open. The caller re-subscribes when the month changes.
  // The upper bound is a plain string compare against '<month>-31', which is
  // correct for every month: '2026-02-31' sorts after '2026-02-28' even
  // though it isn't a real date. Single-field range filter, so Firestore's
  // automatic index covers it — no composite index to create in the console.
  watchDutiesForMonth(month, callback) {
    return firestore
      .collection('duties')
      .where('date', '>=', `${month}-01`)
      .where('date', '<=', `${month}-31`)
      .onSnapshot(
        (snapshot) => {
          callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        },
        (error) => console.error('watchDutiesForMonth failed', error)
      );
  },

  // One-time (not live) read of one month of duties, for "copy last month
  // as a starting point". Deliberately a .get() rather than a second
  // onSnapshot, same reasoning as getOlderNotifications: the roster only ever
  // watches the month on screen, and standing up a listener on a month nobody
  // is looking at would undo the point of scoping the watcher at all.
  async getDutiesForMonth(month) {
    const snapshot = await firestore
      .collection('duties')
      .where('date', '>=', `${month}-01`)
      .where('date', '<=', `${month}-31`)
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

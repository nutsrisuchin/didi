const ROLE_ORDER = { Employee: 1, Manager: 2, Admin: 3, 'App Owner': 4 };

const state = {
  view: 'home',
  currentDate: todayISO(),
  currentUser: null,
  currentStaff: null,
  currentRole: null,
  staff: [],
  attendance: [],
  warehouseItems: [],
  routines: [],
  routineInspections: [],
  notifications: [],
  collapsedStockCategories: new Set()
};

const notifiedOverdueRoutineIds = new Set();
let watchersStarted = false;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function roleAtLeast(minRole) {
  return ROLE_ORDER[state.currentRole] >= ROLE_ORDER[minRole];
}

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '—';
  return `฿${Number(amount).toLocaleString('en-US')}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function roundUpToHalfHour(timeValue) {
  if (!timeValue) return '10:00';
  const [hours, minutes] = timeValue.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes;
  const step = 30;
  const rounded = Math.ceil(totalMinutes / step) * step;
  const safeRounded = rounded >= 24 * 60 ? 24 * 60 - step : rounded;
  const roundedHours = Math.floor(safeRounded / 60);
  const roundedMinutes = safeRounded % 60;
  return `${String(roundedHours).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`;
}

function scheduleFor(dateValue) {
  const isWeekend = [0, 6].includes(new Date(dateValue).getDay());
  return isWeekend ? { start: '09:00', end: '20:00' } : { start: '10:00', end: '21:00' };
}

// Part-time only — full-time deduction rules are intentionally deferred.
function calculatePartTimePay(workedHours, lateMinutes) {
  const base = 440;
  const foodAllowance = workedHours < 8 ? 50 : 0;
  const latePenalty = Math.ceil(lateMinutes / 60) * 40;
  return Math.max(0, base + foodAllowance - latePenalty);
}

// No Firebase Storage (requires the paid Blaze plan) — photos are downscaled
// and JPEG-compressed client-side, then stored as a base64 data URL directly
// on the Firestore doc. Firestore caps a document at 1MiB total, so this
// targets well under that per image (a 640px-wide JPEG at 0.6 quality is
// typically tens of KB) rather than relying on the original phone-camera file.
function fileToCompressedDataUrl(file, maxDimension = 640, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function attendanceId(staffId, date) {
  return `${date}_${staffId}`;
}

function getAttendanceForDate(staffId, date) {
  return state.attendance.find((entry) => entry.id === attendanceId(staffId, date)) || null;
}

function getRoutineStatus(routine) {
  const last = routine.lastInspectedAt ? new Date(routine.lastInspectedAt) : new Date(routine.createdAt || nowISO());
  const due = new Date(last);
  due.setDate(due.getDate() + Number(routine.frequencyDays || 1));
  return due < new Date() ? 'overdue' : 'on-track';
}

function upsertLocal(collection, record) {
  const list = state[collection];
  const index = list.findIndex((entry) => entry.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

function removeLocal(collection, id) {
  state[collection] = state[collection].filter((entry) => entry.id !== id);
}

async function pushNotification(title, detail) {
  const note = { id: DB.uid('note'), title, detail, createdAt: nowISO(), read: false };
  await DB.put('notifications', note);
  upsertLocal('notifications', note);
}

function checkRoutineOverdueNotifications() {
  state.routines.forEach((routine) => {
    const status = getRoutineStatus(routine);
    if (status === 'overdue' && !notifiedOverdueRoutineIds.has(routine.id)) {
      notifiedOverdueRoutineIds.add(routine.id);
      pushNotification('Routine inspection overdue', `${routine.name} is past due and hasn't been inspected.`);
    } else if (status !== 'overdue' && notifiedOverdueRoutineIds.has(routine.id)) {
      notifiedOverdueRoutineIds.delete(routine.id);
    }
  });
}

// --- Auth ---------------------------------------------------------------

function showLoginGate() {
  document.querySelector('#login-gate').hidden = false;
  document.querySelector('#app-root').hidden = true;
}

function hideLoginGate() {
  document.querySelector('#login-gate').hidden = true;
  document.querySelector('#app-root').hidden = false;
}

async function ensureStaffDoc(user) {
  let staffDoc = await DB.getOnce('staff', user.uid);
  if (!staffDoc && user.email === DB.OWNER_EMAIL) {
    await DB.put('staff', {
      id: user.uid,
      name: 'Owner',
      role: 'App Owner',
      employmentType: '',
      salary: null,
      active: true,
      createdAt: nowISO()
    });
    staffDoc = await DB.getOnce('staff', user.uid);
  }
  state.currentStaff = staffDoc;
  state.currentRole = staffDoc ? staffDoc.role : null;
}

function refreshCurrentRole() {
  if (!state.currentUser) return;
  const doc = state.staff.find((entry) => entry.id === state.currentUser.uid);
  if (doc) {
    state.currentStaff = doc;
    state.currentRole = doc.role;
  }
}

function startWatchers() {
  if (watchersStarted) return;
  watchersStarted = true;
  DB.watch('staff', (records) => {
    state.staff = records;
    refreshCurrentRole();
    render();
  });
  DB.watch('attendance', (records) => {
    state.attendance = records;
    render();
  });
  DB.watch('warehouseItems', (records) => {
    state.warehouseItems = records;
    render();
  });
  DB.watch('routines', (records) => {
    state.routines = records;
    checkRoutineOverdueNotifications();
    render();
  });
  DB.watch('routineInspections', (records) => {
    state.routineInspections = records;
    render();
  });
  DB.watch('notifications', (records) => {
    state.notifications = records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    render();
  });
}

function initAuthGate() {
  const form = document.querySelector('#login-form');
  const errorEl = document.querySelector('#login-error');
  form.onsubmit = async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const formData = new FormData(form);
    try {
      await DB.login(formData.get('name'), formData.get('pin'));
    } catch (error) {
      errorEl.textContent = 'Login failed — check the name and PIN.';
      errorEl.hidden = false;
    }
  };

  DB.onAuthChange(async (user) => {
    if (!user) {
      state.currentUser = null;
      state.currentRole = null;
      state.currentStaff = null;
      showLoginGate();
      return;
    }
    state.currentUser = user;
    await ensureStaffDoc(user);
    if (!state.currentRole) {
      errorEl.textContent = 'No active staff account found for this login. Contact an admin.';
      errorEl.hidden = false;
      await DB.logout();
      return;
    }
    hideLoginGate();
    startWatchers();
    render();
  });
}

// --- Render ---------------------------------------------------------------

function renderSidebarSummary() {
  const summary = document.querySelector('#sidebar-summary');
  const dueRoutines = state.routines.filter((routine) => getRoutineStatus(routine) === 'overdue').length;
  const lowStock = state.warehouseItems.filter((item) => Number(item.quantity) <= 3).length;
  const unreadNotifications = state.notifications.filter((note) => !note.read).length;
  summary.innerHTML = `
    <div class="stat">
      <strong>${state.staff.filter((s) => s.employmentType).length}</strong>
      <span class="muted">Staff on payroll</span>
    </div>
    <div class="stat">
      <strong>${dueRoutines}</strong>
      <span class="muted">Routine inspections due</span>
    </div>
    <div class="stat">
      <strong>${lowStock}</strong>
      <span class="muted">Low-stock items</span>
    </div>
    <div class="stat">
      <strong>${unreadNotifications}</strong>
      <span class="muted">Unread notifications</span>
    </div>
  `;
}

function render() {
  if (state.view === 'admin' && !roleAtLeast('Admin')) state.view = 'home';
  renderSidebarSummary();
  document.querySelector('#current-user-label').textContent = state.currentStaff
    ? `${state.currentStaff.name} · ${state.currentRole}`
    : '';
  const content = document.querySelector('#view');
  if (state.view === 'home') {
    content.innerHTML = renderHome();
  } else if (state.view === 'timesheet') {
    content.innerHTML = renderTimesheet();
  } else if (state.view === 'warehouse') {
    content.innerHTML = renderWarehouse();
  } else if (state.view === 'routines') {
    content.innerHTML = renderRoutines();
  } else if (state.view === 'admin') {
    content.innerHTML = renderAdmin();
  } else if (state.view === 'notifications') {
    content.innerHTML = renderNotifications();
  }
  bindView();
  document.querySelectorAll('.nav-btn').forEach((button) => {
    const roleMin = button.dataset.roleMin;
    button.hidden = roleMin ? !roleAtLeast(roleMin) : false;
    button.classList.toggle('active', button.dataset.view === state.view);
  });
}

function renderHome() {
  const dueRoutines = state.routines.filter((routine) => getRoutineStatus(routine) === 'overdue');
  const todayAttendance = state.attendance.filter((entry) => entry.date === state.currentDate).length;
  return `
    <div class="grid">
      <section class="card">
        <div class="row">
          <h2 style="margin:0">Today's snapshot</h2>
          <span class="badge">${todayAttendance} marked present</span>
        </div>
        <div class="grid grid-2" style="margin-top:0.8rem">
          <div class="card" style="box-shadow:none; border:1px solid #edf3f8;">
            <h3 style="margin:0 0 0.5rem">Routine inspections</h3>
            <p class="muted">${dueRoutines.length ? `${dueRoutines.length} items need attention.` : 'All inspections are current.'}</p>
          </div>
          <div class="card" style="box-shadow:none; border:1px solid #edf3f8;">
            <h3 style="margin:0 0 0.5rem">Warehouse health</h3>
            <p class="muted">${state.warehouseItems.filter((item) => Number(item.quantity) <= 3).length} items are low in stock.</p>
          </div>
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Due inspections</h2>
        <div class="list">
          ${dueRoutines.length ? dueRoutines.map((routine) => `
            <div class="list-item">
              <div>
                <strong>${routine.name}</strong>
                <div class="muted">Last inspected ${formatDate(routine.lastInspectedAt)}</div>
              </div>
              <button class="btn secondary" data-action="go-routines">Open routine</button>
            </div>
          `).join('') : '<p class="muted">No overdue inspections right now.</p>'}
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Notifications</h2>
        <div class="list">
          ${state.notifications.slice(0, 5).length ? state.notifications.slice(0, 5).map((note) => `
            <div class="list-item">
              <div>
                <strong>${note.title}</strong>
                <div class="muted">${note.detail}</div>
              </div>
              <span class="badge">${formatDate(note.createdAt)}</span>
            </div>
          `).join('') : '<p class="muted">No notifications yet.</p>'}
        </div>
      </section>
    </div>
  `;
}

function renderTimesheet() {
  const canManage = roleAtLeast('Manager');
  const staffList = canManage
    ? state.staff.filter((s) => s.employmentType)
    : state.staff.filter((s) => s.id === state.currentUser?.uid);

  const rows = staffList.map((employee) => {
    const entry = getAttendanceForDate(employee.id, state.currentDate);
    const schedule = scheduleFor(state.currentDate);
    return `
      <div class="list-item">
        <div>
          <strong>${employee.name}</strong>
          <div class="muted">${employee.employmentType} · ${employee.role}</div>
          ${entry
            ? `<div class="small">Clock in ${entry.clockIn} · Clock out ${entry.clockOut} · Worked ${entry.workedHours}h · Late ${entry.lateMinutes}min${entry.pay !== null ? ` · Pay ${formatCurrency(entry.pay)}` : ''}</div>`
            : '<div class="small">Not marked today</div>'}
        </div>
        ${canManage ? `
          <div class="row">
            <input class="mini-input" type="time" value="${entry?.clockIn || schedule.start}" data-arrival-for="${employee.id}" />
            <button class="btn" data-action="mark-attendance" data-id="${employee.id}">Mark present</button>
            <button class="btn secondary" data-action="clear-attendance" data-id="${employee.id}">Clear</button>
            ${employee.role === 'Employee' ? `<button class="btn danger" data-action="delete-staff" data-id="${employee.id}">Remove employee</button>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">Timesheet overview</h2>
        <form data-form="date-form" class="row">
          <label style="min-width:220px">
            Select date
            <input type="date" name="date" value="${state.currentDate}" />
          </label>
          <button class="btn" type="submit">Load</button>
        </form>
      </section>
      <section class="card">
        <div class="row">
          <h2 style="margin:0">${canManage ? 'Employees' : 'Your attendance'} for ${formatDate(state.currentDate)}</h2>
        </div>
        <div class="list" style="margin-top:0.8rem">${rows || '<p class="muted">Nothing to show.</p>'}</div>
      </section>
      ${canManage ? `
        <section class="card">
          <h2 style="margin-top:0">Add employee</h2>
          <form data-form="employee-form" class="stack">
            <div class="form-grid">
              <label>
                Name
                <input name="name" required />
              </label>
              <label>
                Role
                <select name="role">
                  <option value="Employee">Employee</option>
                  <option value="Manager">Manager</option>
                </select>
              </label>
              <label>
                Employment type
                <select name="employmentType" required>
                  <option value="full-time">Full-time</option>
                  <option value="part-time">Part-time</option>
                </select>
              </label>
              <label>
                Fixed monthly salary (full-time only)
                <input name="salary" type="number" value="15000" />
              </label>
              <label>
                Login PIN
                <input name="pin" type="password" inputmode="numeric" required />
              </label>
            </div>
            <button class="btn" type="submit">Add employee</button>
          </form>
        </section>
      ` : ''}
    </div>
  `;
}

// One-time seed for the "Import from stock sheet" button — quantities are the
// most recent (26/7/69) column from stock_data_1.md, the paper stock check log.
const STOCK_SEED_DATA = [
  { category: 'ฟองเต้าหู้', name: 'ฟองเต้าหู้แห้ง แบบแท่ง', unit: 'แพ็ค', quantity: 2 },
  { category: 'ฟองเต้าหู้', name: 'ฟองเต้าหู้แห้ง เส้นเล็ก', unit: 'ถุง', quantity: 1.8 },
  { category: 'ฟองเต้าหู้', name: 'ฟองเต้าหู้ม้วน/ทอด', unit: 'แพ็ค', quantity: 42 },
  { category: 'เส้น,อื่นๆ', name: 'บะหมี่ผัก มันม่วง', unit: 'ห่อ', quantity: 32 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นหนึบ มันเทศ', unit: 'ห่อ', quantity: 0 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นหนึบ ฟักทอง', unit: 'ห่อ', quantity: 0 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นหนึบใหญ่', unit: 'ห่อ', quantity: 179 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นหนึบกลมเล็ก', unit: 'ห่อ', quantity: 39 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นอูด้ง', unit: 'ห่อ', quantity: 26 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นดำ รากเฟิร์น', unit: 'ม้วน', quantity: 9 },
  { category: 'เส้น,อื่นๆ', name: 'เส้นราเมง', unit: 'ห่อ', quantity: 23 },
  { category: 'เส้น,อื่นๆ', name: 'สาหร่ายวากาเมะ', unit: 'กระปุก', quantity: 2.2 },
  { category: 'เส้น,อื่นๆ', name: 'ผักกุ๊งฉ่าย', unit: 'แพ็ค', quantity: 8 },
  { category: 'เครื่องดื่ม', name: 'น้ำหวังเหล่าจี๋', unit: 'กระป๋อง', quantity: 46 },
  { category: 'เครื่องดื่ม', name: 'น้ำฟักเขียว', unit: 'กระป๋อง', quantity: 12 },
  { category: 'เครื่องดื่ม', name: 'นมแดง', unit: 'กระป๋อง', quantity: 26 },
  { category: 'เครื่องดื่ม', name: 'ชานมไต้หวัน', unit: 'ขวด', quantity: 11 },
  { category: 'เครื่องดื่ม', name: 'ชาเขียวบ้วย', unit: 'ขวด', quantity: 0 },
  { category: 'เครื่องดื่ม', name: 'น้ำจับเลี้ยง', unit: 'กระป๋อง', quantity: 24 },
  { category: 'พลาสติก,อื่นๆ', name: 'ถ้วยน้ำจิ้ม 2 ออนซ์', unit: 'แพ็ค', quantity: 26 },
  { category: 'พลาสติก,อื่นๆ', name: 'ถ้วยน้ำจิ้ม 1 ออนซ์', unit: 'แพ็ค', quantity: 53 },
  { category: 'พลาสติก,อื่นๆ', name: 'กระดาษทิชชู่แบบแขวน', unit: 'แพ็ค', quantity: 4 },
  { category: 'พลาสติก,อื่นๆ', name: 'กระดาษทิชชู่อันเล็ก', unit: 'แพ็ค', quantity: 31 },
  { category: 'พลาสติก,อื่นๆ', name: 'กระดาษใบเสร็จ pos', unit: 'ม้วน', quantity: 10 },
  { category: 'พลาสติก,อื่นๆ', name: 'กระดาษใบเสร็จ grab 57x40', unit: 'ม้วน', quantity: 54 },
  { category: 'พลาสติก,อื่นๆ', name: 'ถ้วยอาหารพลาสติก 1,000ml', unit: 'แพ็ค', quantity: 11 },
  { category: 'อื่นๆ', name: 'เกี๊ยวกุ้งหมูสับ', unit: 'แพ็ค', quantity: 3 }
];

function groupWarehouseItemsByCategory() {
  const groups = new Map();
  state.warehouseItems.forEach((item) => {
    const category = item.category || 'อื่นๆ';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  });
  return groups;
}

function renderWarehouse() {
  const canManage = roleAtLeast('Manager');
  const categories = Array.from(new Set(state.warehouseItems.map((item) => item.category || 'อื่นๆ')));
  const categoryOptions = categories.map((category) => `<option value="${category}"></option>`).join('');
  const groups = groupWarehouseItemsByCategory();

  const sections = Array.from(groups.entries()).map(([category, items]) => {
    const collapsed = state.collapsedStockCategories.has(category);
    const rows = items.map((item) => `
      <div class="stock-row">
        ${item.imageUrl
          ? `<img class="stock-thumb" src="${item.imageUrl}" alt="${item.name}" />`
          : '<div class="stock-thumb-empty"></div>'}
        <span class="stock-name">${item.name}</span>
        <span class="stock-qty">${item.quantity}</span>
        <span class="stock-unit">${item.unit}</span>
      </div>
      ${canManage ? `
        <div class="stock-manage">
          <input class="mini-input" type="number" min="0" step="any" value="${item.quantity}" data-quantity-for="${item.id}" />
          <button class="btn secondary" data-action="update-item-quantity" data-id="${item.id}">Update</button>
          <button class="btn danger" data-action="delete-item" data-id="${item.id}">Delete</button>
        </div>
      ` : ''}
    `).join('');

    return `
      <div class="stock-category">
        <button type="button" class="stock-category-header" data-action="toggle-warehouse-category" data-category="${category}">
          <span class="stock-toggle ${collapsed ? 'collapsed' : ''}">▼</span> หมวด${category}
        </button>
        ${collapsed ? '' : `
          <div class="stock-table">
            <div class="stock-row stock-row-head">
              <span>รายการ</span><span>ชื่อ</span><span>จำนวน</span><span>หน่วย</span>
            </div>
            ${rows}
          </div>
        `}
      </div>
    `;
  }).join('');

  return `
    <div class="grid">
      ${canManage ? `
        <section class="card">
          <h2 style="margin-top:0">Warehouse inventory</h2>
          <form data-form="item-form" class="stack">
            <div class="form-grid">
              <label>
                หมวด (category)
                <input name="category" list="category-options" placeholder="e.g. เครื่องดื่ม" required />
                <datalist id="category-options">${categoryOptions}</datalist>
              </label>
              <label>
                รายการ (item name)
                <input name="name" required />
              </label>
              <label>
                หน่วย (unit)
                <input name="unit" placeholder="box, bottle, pack, kg" required />
              </label>
              <label>
                จำนวน (remaining units)
                <input name="quantity" type="number" min="0" step="any" required />
              </label>
              <label>
                Image
                <input name="image" type="file" accept="image/*" capture="environment" />
              </label>
            </div>
            <button class="btn" type="submit">Add item</button>
          </form>
        </section>
      ` : ''}
      ${canManage && state.warehouseItems.length === 0 ? `
        <section class="card">
          <h2 style="margin-top:0">Import past stock sheet</h2>
          <p class="muted">One-time import of the ${STOCK_SEED_DATA.length} items and หมวด from the most recent paper stock check (26/7/69). This only shows while the warehouse is empty.</p>
          <button class="btn secondary" data-action="import-stock-seed">Import from stock sheet</button>
        </section>
      ` : ''}
      <section class="card">
        <h2 style="margin-top:0">Stock sheet</h2>
        <div class="stock-sheet">${sections || '<p class="muted">No items yet.</p>'}</div>
      </section>
    </div>
  `;
}

function renderRoutines() {
  const canManage = roleAtLeast('Manager');
  const rows = state.routines.map((routine) => {
    const status = getRoutineStatus(routine);
    return `
      <div class="list-item">
        <div>
          <strong>${routine.name}</strong>
          <div class="muted">Every ${routine.frequencyDays} day(s) · Last inspected ${formatDate(routine.lastInspectedAt)}</div>
          <div class="small">Status: <span class="badge ${status === 'overdue' ? 'overdue' : ''}">${status}</span></div>
          ${routine.lastInspectedImageUrl ? `<img class="img-preview" src="${routine.lastInspectedImageUrl}" alt="${routine.name}" />` : ''}
        </div>
        <div class="row">
          <input type="file" accept="image/*" capture="environment" data-routine-image-for="${routine.id}" />
          <button class="btn" data-action="inspect-routine" data-id="${routine.id}">Upload inspection photo</button>
          ${canManage ? `<button class="btn danger" data-action="delete-routine" data-id="${routine.id}">Delete</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="grid">
      ${canManage ? `
        <section class="card">
          <h2 style="margin-top:0">Routine inspections</h2>
          <form data-form="routine-form" class="stack">
            <div class="form-grid">
              <label>
                Routine name
                <input name="name" required />
              </label>
              <label>
                Frequency (days)
                <input name="frequencyDays" type="number" min="1" value="7" required />
              </label>
            </div>
            <button class="btn" type="submit">Create routine</button>
          </form>
        </section>
      ` : ''}
      <section class="card">
        <h2 style="margin-top:0">Active routines</h2>
        <div class="list">${rows || '<p class="muted">No routines yet.</p>'}</div>
      </section>
    </div>
  `;
}

function renderAdmin() {
  const rows = state.staff.map((person) => `
    <div class="list-item">
      <div>
        <strong>${person.name}</strong>
        <div class="muted">${person.role}${person.employmentType ? ` · ${person.employmentType}` : ''}</div>
      </div>
      ${person.role !== 'App Owner' ? `<button class="btn danger" data-action="delete-staff" data-id="${person.id}">Remove access</button>` : ''}
    </div>
  `).join('');

  return `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">Admin management</h2>
        <p class="muted">Removing access deletes the app profile — the underlying login can't be hard-deleted from the browser, so removed staff simply won't have a profile to sign in with anymore.</p>
        <form data-form="staff-form" class="stack">
          <div class="form-grid">
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Role
              <select name="role">
                <option value="App Owner">App Owner</option>
                <option value="Admin">Admin</option>
                <option value="Manager">Manager</option>
                <option value="Employee">Employee</option>
              </select>
            </label>
            <label>
              Employment type (staff only)
              <select name="employmentType">
                <option value="">N/A</option>
                <option value="full-time">Full-time</option>
                <option value="part-time">Part-time</option>
              </select>
            </label>
            <label>
              Fixed monthly salary (full-time only)
              <input name="salary" type="number" value="0" />
            </label>
            <label>
              Login PIN
              <input name="pin" type="password" inputmode="numeric" required />
            </label>
          </div>
          <button class="btn" type="submit">Add account</button>
        </form>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Roles</h2>
        <div class="list">${rows}</div>
      </section>
    </div>
  `;
}

function renderNotifications() {
  return `
    <div class="grid">
      <section class="card">
        <div class="row">
          <h2 style="margin:0">Notifications</h2>
          <button class="btn secondary" data-action="mark-all-read">Mark all as read</button>
        </div>
        <div class="list" style="margin-top:0.8rem">
          ${state.notifications.length ? state.notifications.map((note) => `
            <div class="list-item">
              <div>
                <strong>${note.title}</strong>
                <div class="muted">${note.detail}</div>
              </div>
              <span class="badge ${note.read ? '' : 'overdue'}">${formatDate(note.createdAt)}</span>
            </div>
          `).join('') : '<p class="muted">No notifications yet.</p>'}
        </div>
      </section>
    </div>
  `;
}

function bindView() {
  document.querySelectorAll('[data-action]').forEach((element) => {
    element.onclick = () => handleAction(element.dataset.action, element.dataset);
  });
  document.querySelectorAll('form[data-form]').forEach((form) => {
    form.onsubmit = (event) => {
      event.preventDefault();
      handleForm(form.dataset.form, new FormData(form));
    };
  });
}

async function createStaffMember(formData) {
  const name = formData.get('name');
  const role = formData.get('role');
  const employmentType = formData.get('employmentType') || '';
  const salary = employmentType === 'full-time' ? Number(formData.get('salary') || 0) : null;
  const pin = formData.get('pin');
  const uid = await DB.createStaffAuthAccount(name, pin);
  const record = {
    id: uid,
    name,
    role,
    employmentType,
    salary,
    active: true,
    createdAt: nowISO()
  };
  await DB.put('staff', record);
  upsertLocal('staff', record);
  return record;
}

async function handleForm(name, formData) {
  if (name === 'employee-form') {
    if (!roleAtLeast('Manager')) return;
    const employee = await createStaffMember(formData);
    await pushNotification('Employee added', `${employee.name} is ready for the timesheet.`);
    render();
    return;
  }

  if (name === 'staff-form') {
    if (!roleAtLeast('Admin')) return;
    const person = await createStaffMember(formData);
    await pushNotification('Admin account added', `${person.name} now has ${person.role} access.`);
    render();
    return;
  }

  if (name === 'item-form') {
    if (!roleAtLeast('Manager')) return;
    const id = DB.uid('item');
    const imageFile = formData.get('image');
    const imageUrl = imageFile && imageFile.name ? await fileToCompressedDataUrl(imageFile) : '';
    const item = {
      id,
      category: formData.get('category') || 'อื่นๆ',
      name: formData.get('name'),
      unit: formData.get('unit'),
      quantity: Number(formData.get('quantity') || 0),
      imageUrl,
      createdAt: nowISO()
    };
    await DB.put('warehouseItems', item);
    upsertLocal('warehouseItems', item);
    await pushNotification('Warehouse item added', `${item.name} is now tracked.`);
    render();
    return;
  }

  if (name === 'routine-form') {
    if (!roleAtLeast('Manager')) return;
    const routine = {
      id: DB.uid('routine'),
      name: formData.get('name'),
      frequencyDays: Number(formData.get('frequencyDays') || 7),
      lastInspectedAt: nowISO(),
      lastInspectedImageUrl: '',
      createdAt: nowISO()
    };
    await DB.put('routines', routine);
    upsertLocal('routines', routine);
    await pushNotification('Routine created', `${routine.name} will be inspected every ${routine.frequencyDays} day(s).`);
    render();
    return;
  }

  if (name === 'date-form') {
    state.currentDate = formData.get('date') || todayISO();
    render();
  }
}

async function handleAction(action, data) {
  if (action.startsWith('nav-')) {
    state.view = action.replace('nav-', '');
    render();
    return;
  }
  if (action === 'go-routines') {
    state.view = 'routines';
    render();
    return;
  }

  if (action === 'logout') {
    await DB.logout();
    return;
  }

  if (action === 'mark-attendance') {
    if (!roleAtLeast('Manager')) return;
    const employee = state.staff.find((entry) => entry.id === data.id);
    if (!employee) return;
    const arrivalInput = document.querySelector(`[data-arrival-for="${data.id}"]`);
    const schedule = scheduleFor(state.currentDate);
    const rawArrival = arrivalInput?.value || schedule.start;
    const roundedArrival = roundUpToHalfHour(rawArrival);
    const lateMinutes = Math.max(0, toMinutes(roundedArrival) - toMinutes(schedule.start));
    const workedHours = Math.max(0, (toMinutes(schedule.end) - toMinutes(roundedArrival)) / 60 - 1);
    const pay = employee.employmentType === 'part-time' ? calculatePartTimePay(workedHours, lateMinutes) : null;
    const record = {
      id: attendanceId(employee.id, state.currentDate),
      staffId: employee.id,
      date: state.currentDate,
      clockIn: roundedArrival,
      clockOut: schedule.end,
      lateMinutes,
      workedHours,
      pay,
      createdAt: nowISO()
    };
    await DB.put('attendance', record);
    upsertLocal('attendance', record);
    await pushNotification('Attendance marked', `${employee.name} logged work for ${formatDate(state.currentDate)}.`);
    render();
    return;
  }

  if (action === 'clear-attendance') {
    if (!roleAtLeast('Manager')) return;
    const id = attendanceId(data.id, state.currentDate);
    await DB.del('attendance', id);
    removeLocal('attendance', id);
    render();
    return;
  }

  if (action === 'toggle-warehouse-category') {
    if (state.collapsedStockCategories.has(data.category)) {
      state.collapsedStockCategories.delete(data.category);
    } else {
      state.collapsedStockCategories.add(data.category);
    }
    render();
    return;
  }

  if (action === 'import-stock-seed') {
    if (!roleAtLeast('Manager')) return;
    if (state.warehouseItems.length > 0) return;
    for (const seed of STOCK_SEED_DATA) {
      const item = { id: DB.uid('item'), ...seed, imageUrl: '', createdAt: nowISO() };
      await DB.put('warehouseItems', item);
      upsertLocal('warehouseItems', item);
    }
    await pushNotification('Stock sheet imported', `${STOCK_SEED_DATA.length} items imported from the 26/7/69 stock check.`);
    render();
    return;
  }

  if (action === 'update-item-quantity') {
    if (!roleAtLeast('Manager')) return;
    const item = state.warehouseItems.find((entry) => entry.id === data.id);
    if (!item) return;
    const input = document.querySelector(`[data-quantity-for="${data.id}"]`);
    const quantity = Math.max(0, Number(input?.value ?? item.quantity));
    const record = { ...item, quantity };
    await DB.put('warehouseItems', record);
    upsertLocal('warehouseItems', record);
    render();
    return;
  }

  if (action === 'delete-item') {
    if (!roleAtLeast('Manager')) return;
    await DB.del('warehouseItems', data.id);
    removeLocal('warehouseItems', data.id);
    render();
    return;
  }

  if (action === 'delete-routine') {
    if (!roleAtLeast('Manager')) return;
    await DB.del('routines', data.id);
    removeLocal('routines', data.id);
    render();
    return;
  }

  if (action === 'delete-staff') {
    // Managers can only remove Employee-role staff; Admin/Owner can remove
    // anyone but the App Owner. Firestore rules enforce the same split
    // server-side, so a stale/forged client request is still rejected there.
    if (!roleAtLeast('Manager')) return;
    const person = state.staff.find((entry) => entry.id === data.id);
    if (!person || person.role === 'App Owner') return;
    if (!roleAtLeast('Admin') && person.role !== 'Employee') return;
    await DB.del('staff', data.id);
    removeLocal('staff', data.id);
    render();
    return;
  }

  if (action === 'mark-all-read') {
    await Promise.all(
      state.notifications.filter((note) => !note.read).map((note) => {
        const record = { ...note, read: true };
        upsertLocal('notifications', record);
        return DB.put('notifications', record);
      })
    );
    render();
    return;
  }

  if (action === 'inspect-routine') {
    const routine = state.routines.find((entry) => entry.id === data.id);
    if (!routine) return;
    const imageInput = document.querySelector(`[data-routine-image-for="${data.id}"]`);
    const file = imageInput?.files?.[0];
    if (!file) return;
    const imageUrl = await fileToCompressedDataUrl(file);
    const updatedRoutine = { ...routine, lastInspectedAt: nowISO(), lastInspectedImageUrl: imageUrl };
    await DB.put('routines', updatedRoutine);
    upsertLocal('routines', updatedRoutine);
    const log = {
      id: DB.uid('insp'),
      routineId: routine.id,
      staffId: state.currentUser?.uid || '',
      imageUrl,
      inspectedAt: nowISO()
    };
    await DB.put('routineInspections', log);
    upsertLocal('routineInspections', log);
    await pushNotification('Inspection uploaded', `${routine.name} was inspected successfully.`);
    render();
  }
}

document.addEventListener('DOMContentLoaded', initAuthGate);

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
  holidays: [],
  warehouseLogs: [],
  collapsedStockCategories: new Set(),
  warehouseEditMode: false,
  financialMonth: monthISO(),
  timesheetMonth: monthISO(),
  selectedScheduleCell: null,
  editingStaffId: null,
  showChangePinModal: false
};

const THAI_WEEKDAY_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

// Firestore values (staff.role, staff.employmentType, routine status) stay in
// English since they're compared against directly (ROLE_ORDER, firestore.rules
// roleRank(), etc.) — these maps translate them for display only.
const ROLE_LABEL_TH = { 'App Owner': 'เจ้าของร้าน', Admin: 'แอดมิน', Manager: 'ผู้จัดการ', Employee: 'พนักงาน' };
const EMPLOYMENT_TYPE_LABEL_TH = { 'full-time': 'เต็มเวลา', 'part-time': 'พาร์ทไทม์' };
const ROUTINE_STATUS_LABEL_TH = { overdue: 'เลยกำหนด', 'on-track': 'ตามกำหนด' };

function roleLabel(role) {
  return ROLE_LABEL_TH[role] || role;
}

function employmentTypeLabel(type) {
  return EMPLOYMENT_TYPE_LABEL_TH[type] || type;
}

function routineStatusLabel(status) {
  return ROUTINE_STATUS_LABEL_TH[status] || status;
}

const notifiedOverdueRoutineIds = new Set();
let watchersStarted = false;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthISO() {
  return new Date().toISOString().slice(0, 7);
}

function datesInMonth(monthValue) {
  const [year, month] = monthValue.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return dates;
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
  if (!timeValue) return '09:30';
  const [hours, minutes] = timeValue.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes;
  const step = 30;
  const rounded = Math.ceil(totalMinutes / step) * step;
  const safeRounded = rounded >= 24 * 60 ? 24 * 60 - step : rounded;
  const roundedHours = Math.floor(safeRounded / 60);
  const roundedMinutes = safeRounded % 60;
  return `${String(roundedHours).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`;
}

// Single fixed schedule for every day of the week (9:30-20:30, 1h unpaid
// lunch → 10 worked hours baseline). Takes dateValue for call-site
// compatibility even though it's unused now that weekday/weekend no longer differ.
function scheduleFor(dateValue) {
  return { start: '09:30', end: '20:30' };
}

// Every employee (full-time and part-time) is paid a custom per-person day
// rate now — no more fixed 440 base or monthly salary. No OT: pay is the
// day rate regardless of exact hours worked, only reduced by lateness and
// multiplied 1.5x on admin-marked holidays. closingDuty is a flat +50 THB
// bonus for whoever closed the till that day ("ปิดบิลแทน") — added after
// the holiday multiplier, not multiplied by it.
function calculateDailyPay(dailyRate, lateMinutes, isHoliday, closingDuty = false) {
  const gross = Number(dailyRate || 0) * (isHoliday ? 1.5 : 1);
  const latePenalty = Math.ceil(lateMinutes / 60) * 40;
  const bonus = closingDuty ? 50 : 0;
  return Math.max(0, gross - latePenalty + bonus);
}

function isHolidayDate(dateValue) {
  return state.holidays.some((holiday) => holiday.date === dateValue);
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

// Two ways a checklist's due-ness is computed: a plain "every N days" interval
// (the original model), or specific weekdays (routine.weekdays, an array of
// Date.getDay() values 0-6) — due starting midnight on a selected weekday
// until it's completed that same day, and simply not due at all on the other
// days of the week. weekdays (when present and non-empty) takes over from
// frequencyDays entirely rather than the two combining.
function getRoutineStatus(routine) {
  if (Array.isArray(routine.weekdays) && routine.weekdays.length) {
    if (!routine.weekdays.includes(new Date().getDay())) return 'on-track';
    const lastDate = routine.lastInspectedAt ? routine.lastInspectedAt.slice(0, 10) : null;
    return lastDate === todayISO() ? 'on-track' : 'overdue';
  }
  const last = routine.lastInspectedAt ? new Date(routine.lastInspectedAt) : new Date(routine.createdAt || nowISO());
  const due = new Date(last);
  due.setDate(due.getDate() + Number(routine.frequencyDays || 1));
  return due < new Date() ? 'overdue' : 'on-track';
}

const TIME_OF_DAY_LABEL_TH = { 'before-open': 'ก่อนเปิดร้าน', 'after-close': 'หลังปิดร้าน' };

function frequencyLabel(routine) {
  if (Array.isArray(routine.weekdays) && routine.weekdays.length) {
    const days = [...routine.weekdays].sort().map((day) => THAI_WEEKDAY_SHORT[day]).join(' ');
    return `ทุกวัน ${days}`;
  }
  return `ทุก ${routine.frequencyDays} วัน`;
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
      pushNotification('เช็คลิสต์เลยกำหนด', `${routine.name} เลยกำหนดแล้วและยังไม่ได้ทำ`);
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
      dailyRate: null,
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
  DB.watch('holidays', (records) => {
    state.holidays = records.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    render();
  });
  DB.watch('warehouseLogs', (records) => {
    state.warehouseLogs = records;
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
      errorEl.textContent = 'เข้าสู่ระบบไม่สำเร็จ — กรุณาตรวจสอบชื่อและ PIN';
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
      errorEl.textContent = 'ไม่พบบัญชีพนักงานที่ใช้งานได้สำหรับการเข้าสู่ระบบนี้ กรุณาติดต่อแอดมิน';
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
      <span class="muted">พนักงานในระบบเงินเดือน</span>
    </div>
    <div class="stat">
      <strong>${dueRoutines}</strong>
      <span class="muted">เช็คลิสต์ที่ครบกำหนด</span>
    </div>
    <div class="stat">
      <strong>${lowStock}</strong>
      <span class="muted">สินค้าใกล้หมด</span>
    </div>
    <div class="stat">
      <strong>${unreadNotifications}</strong>
      <span class="muted">แจ้งเตือนที่ยังไม่อ่าน</span>
    </div>
  `;
}

function render() {
  if ((state.view === 'admin' || state.view === 'financial') && !roleAtLeast('Admin')) state.view = 'home';
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
  } else if (state.view === 'warehouse-analytics') {
    content.innerHTML = renderWarehouseAnalytics();
  } else if (state.view === 'routines') {
    content.innerHTML = renderRoutines();
  } else if (state.view === 'admin') {
    content.innerHTML = renderAdmin();
  } else if (state.view === 'notifications') {
    content.innerHTML = renderNotifications();
  } else if (state.view === 'financial') {
    content.innerHTML = renderFinancial();
  }
  document.querySelector('#modal-host').innerHTML = renderScheduleModal() + renderStaffEditModal() + renderChangePinModal();
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
  const lowStockCount = state.warehouseItems.filter((item) => Number(item.quantity) <= 3).length;
  return `
    <div class="grid">
      <div class="row" style="gap:0.9rem">
        <img class="home-logo" src="logo.jpg" alt="Didi Malatang" />
        <div>
          <p class="eyebrow" style="margin:0">Didi Malatang</p>
          <h2 style="margin:0; font-size:1.15rem">ยินดีต้อนรับกลับ${state.currentStaff ? ` คุณ${state.currentStaff.name}` : ''}</h2>
        </div>
      </div>
      <section class="card">
        <div class="row">
          <h2 style="margin:0">สรุปวันนี้</h2>
          <span class="badge">${todayAttendance} คนลงเวลาแล้ว</span>
        </div>
        <div class="grid grid-2" style="margin-top:0.8rem">
          <div class="card" style="box-shadow:none; border:1px solid var(--color-border-soft);">
            <h3 style="margin:0 0 0.5rem">เช็คลิสต์</h3>
            <p class="muted">${dueRoutines.length ? `มี ${dueRoutines.length} รายการที่ต้องดำเนินการ` : 'เช็คลิสต์ทั้งหมดเป็นปัจจุบันแล้ว'}</p>
          </div>
          <div class="card clickable" data-action="nav-warehouse" style="box-shadow:none; border:1px solid var(--color-border-soft);">
            <h3 style="margin:0 0 0.5rem">สุขภาพคลังสินค้า</h3>
            <p class="muted">มี ${lowStockCount} รายการใกล้หมด</p>
            <p class="small" style="margin:0.4rem 0 0; color:var(--color-primary);">แตะเพื่อดูลำดับการเติมสต็อก →</p>
          </div>
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">เช็คลิสต์ที่ครบกำหนด</h2>
        <div class="list">
          ${dueRoutines.length ? dueRoutines.map((routine) => `
            <div class="list-item">
              <div>
                <strong>${routine.name}</strong>
                <div class="muted">ทำครั้งล่าสุดเมื่อ ${formatDate(routine.lastInspectedAt)}</div>
              </div>
              <button class="btn secondary" data-action="go-routines">เปิดเช็คลิสต์</button>
            </div>
          `).join('') : '<p class="muted">ไม่มีเช็คลิสต์ที่เลยกำหนดในตอนนี้</p>'}
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">การแจ้งเตือน</h2>
        <div class="list">
          ${state.notifications.slice(0, 5).length ? state.notifications.slice(0, 5).map((note) => `
            <div class="list-item">
              <div>
                <strong>${note.title}</strong>
                <div class="muted">${note.detail}</div>
              </div>
              <span class="badge">${formatDate(note.createdAt)}</span>
            </div>
          `).join('') : '<p class="muted">ยังไม่มีการแจ้งเตือน</p>'}
        </div>
      </section>
    </div>
  `;
}

// Default assumption: everyone works their normal schedule every day unless
// a manager explicitly marks a day off (record.dayOff === true). A record
// with real clockIn/clockOut (from the quick daily mark, or the "exact time"
// override below) represents an actual logged day and always wins. No
// record at all is NOT treated as absent — it's the implicit "working as
// scheduled, on time" default, since requiring a manager to fill in two time
// fields for every single normal working day was the actual complaint this
// redesign responds to.
function renderMonthlySchedule(staffList, interactive = true) {
  const dates = datesInMonth(state.timesheetMonth);
  const headerCells = staffList.map((employee) => `<th>${employee.name}</th>`).join('');

  const bodyRows = dates.map((dateStr) => {
    const dayOfWeek = THAI_WEEKDAY_SHORT[new Date(dateStr).getDay()];
    const dayNum = Number(dateStr.slice(8, 10));
    const schedule = scheduleFor(dateStr);
    const cells = staffList.map((employee) => {
      const record = getAttendanceForDate(employee.id, dateStr);
      const dayOff = record?.dayOff === true;
      const selected = state.selectedScheduleCell
        && state.selectedScheduleCell.staffId === employee.id
        && state.selectedScheduleCell.date === dateStr;
      const classes = ['schedule-cell'];
      if (dayOff) classes.push('off');
      if (record && !dayOff && record.lateMinutes > 0) classes.push('late');
      if (selected) classes.push('selected');
      const label = dayOff ? 'หยุด' : record ? `${record.clockIn}-${record.clockOut}` : `${schedule.start}-${schedule.end}`;
      return interactive
        ? `<td><button type="button" class="${classes.join(' ')}" data-action="select-schedule-cell" data-staff-id="${employee.id}" data-date="${dateStr}">${label}</button></td>`
        : `<td><span class="${classes.join(' ')}">${label}</span></td>`;
    }).join('');
    return `<tr><td class="schedule-daylabel">${dayOfWeek} ${dayNum}</td>${cells}</tr>`;
  }).join('');

  return `
    <table class="schedule-table">
      <thead><tr><th>วัน</th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function renderScheduleSummary(staffList) {
  const dates = datesInMonth(state.timesheetMonth);
  const rows = staffList.map((employee) => {
    let worked = 0;
    let off = 0;
    let late = 0;
    dates.forEach((dateStr) => {
      const record = getAttendanceForDate(employee.id, dateStr);
      if (record?.dayOff) {
        off++;
      } else {
        worked++;
        if (record && record.lateMinutes > 0) late++;
      }
    });
    return `
      <tr>
        <td>${employee.name}</td>
        <td>${worked}</td>
        <td>${off}</td>
        <td>${late}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="schedule-summary-table">
      <thead><tr><th>ชื่อ</th><th>วันที่ทำงาน</th><th>วันหยุด</th><th>มาสาย</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Popup instead of an inline panel further down the page — clicking a cell
// in a 31-row grid used to mean scrolling all the way down to find the
// editor, which is exactly the "hard to work with" complaint this responds
// to. This is the app's first modal; see #modal-host in index.html and the
// backdrop-click-to-close wiring in bindView().
function renderScheduleModal() {
  if (!state.selectedScheduleCell) return '';
  const { staffId, date } = state.selectedScheduleCell;
  const employee = state.staff.find((entry) => entry.id === staffId);
  if (!employee) {
    state.selectedScheduleCell = null;
    return '';
  }
  const record = getAttendanceForDate(staffId, date);
  const dayOff = record?.dayOff === true;
  const schedule = scheduleFor(date);
  return `
    <div class="modal-backdrop" data-close-action="close-schedule-cell">
      <div class="modal-card">
        <h3 style="margin:0 0 0.5rem">${employee.name} · ${formatDate(date)}</h3>
        <p class="muted small">ค่าเริ่มต้นคือมาทำงานตามปกติ (${schedule.start}-${schedule.end}) ไม่ต้องทำอะไรเพิ่ม เว้นแต่วันนี้เป็นวันหยุด</p>
        <div class="stack">
          ${dayOff
            ? `<button class="btn" data-action="clear-schedule-cell">ยกเลิกวันหยุด (กลับมาทำงานตามปกติ)</button>`
            : `<button class="btn danger" data-action="mark-schedule-dayoff">ทำเครื่องหมายวันหยุด</button>
               <button class="btn secondary" data-action="toggle-closing-duty">${record?.closingDuty ? 'ยกเลิกปิดบิลแทน (-50 บาท)' : 'ปิดบิลแทน (+50 บาท)'}</button>`}
        </div>
        ${dayOff ? '' : `
          <p class="small muted" style="margin:0.6rem 0 0">หรือระบุเวลาเข้า-ออกงานที่แน่นอน (เช่น มาสาย/ออกก่อน)</p>
          <div class="form-grid" style="margin-top:0.5rem">
            <label>
              เวลาเข้างาน
              <input type="time" id="schedule-on-input" value="${record?.clockIn || schedule.start}" />
            </label>
            <label>
              เวลาเลิกงาน
              <input type="time" id="schedule-off-input" value="${record?.clockOut || schedule.end}" />
            </label>
          </div>
          <button class="btn secondary" data-action="save-schedule-cell" style="margin-top:0.5rem">บันทึกเวลาที่แน่นอน</button>
        `}
        <button class="btn secondary" style="margin-top:0.8rem; width:100%;" data-action="close-schedule-cell">ปิด</button>
      </div>
    </div>
  `;
}

// Admin+ only edit for an existing staff member's own info — separate from
// the staff-form creation form on the same page. Reuses the same modal
// system as the schedule-cell popup; #modal-host just concatenates whatever
// modal(s) are currently open (in practice only one at a time).
function renderStaffEditModal() {
  if (!state.editingStaffId) return '';
  const person = state.staff.find((entry) => entry.id === state.editingStaffId);
  if (!person || person.role === 'App Owner') {
    state.editingStaffId = null;
    return '';
  }
  return `
    <div class="modal-backdrop" data-close-action="close-staff-edit">
      <div class="modal-card">
        <h3 style="margin:0 0 0.5rem">แก้ไขข้อมูล: ${person.name}</h3>
        <div class="stack">
          <label>
            ชื่อ
            <input id="staff-edit-name" value="${person.name}" required />
          </label>
          <label>
            ตำแหน่ง
            <select id="staff-edit-role">
              <option value="App Owner" ${person.role === 'App Owner' ? 'selected' : ''}>เจ้าของร้าน</option>
              <option value="Admin" ${person.role === 'Admin' ? 'selected' : ''}>แอดมิน</option>
              <option value="Manager" ${person.role === 'Manager' ? 'selected' : ''}>ผู้จัดการ</option>
              <option value="Employee" ${person.role === 'Employee' ? 'selected' : ''}>พนักงาน</option>
            </select>
          </label>
          <label>
            ประเภทการจ้างงาน (เฉพาะพนักงาน)
            <select id="staff-edit-employment-type">
              <option value="" ${!person.employmentType ? 'selected' : ''}>ไม่มี</option>
              <option value="full-time" ${person.employmentType === 'full-time' ? 'selected' : ''}>เต็มเวลา</option>
              <option value="part-time" ${person.employmentType === 'part-time' ? 'selected' : ''}>พาร์ทไทม์</option>
            </select>
          </label>
          <label>
            ค่าจ้างต่อวัน (฿, เฉพาะพนักงาน)
            <input id="staff-edit-daily-rate" type="number" min="0" value="${person.dailyRate ?? 0}" />
          </label>
        </div>
        <div class="row" style="margin-top:0.8rem">
          <button class="btn" data-action="save-staff-edit">บันทึก</button>
          <button class="btn secondary" data-action="close-staff-edit">ปิด</button>
        </div>
      </div>
    </div>
  `;
}

// Self-service PIN change, reachable from the topbar user-chip by anyone
// signed in — see DB.changePassword in db.js for why it needs the current
// PIN too, not just the new one.
function renderChangePinModal() {
  if (!state.showChangePinModal) return '';
  return `
    <div class="modal-backdrop" data-close-action="close-change-pin">
      <div class="modal-card">
        <h3 style="margin:0 0 0.5rem">เปลี่ยนรหัส PIN</h3>
        <div class="stack">
          <label>
            รหัส PIN ปัจจุบัน
            <input type="password" inputmode="numeric" autocomplete="current-password" id="current-pin-input" />
          </label>
          <label>
            รหัส PIN ใหม่ (อย่างน้อย 6 หลัก)
            <input type="password" inputmode="numeric" autocomplete="new-password" id="new-pin-input" />
          </label>
          <label>
            ยืนยันรหัส PIN ใหม่
            <input type="password" inputmode="numeric" autocomplete="new-password" id="confirm-pin-input" />
          </label>
        </div>
        <p id="change-pin-error" class="error" hidden></p>
        <div class="row" style="margin-top:0.8rem">
          <button class="btn" data-action="submit-change-pin">บันทึก</button>
          <button class="btn secondary" data-action="close-change-pin">ปิด</button>
        </div>
      </div>
    </div>
  `;
}

function renderTimesheet() {
  const canManage = roleAtLeast('Manager');
  const staffList = state.staff.filter((s) => s.employmentType);

  // Employees see everyone's monthly schedule (read-only) so they know who's
  // on/off — but only the schedule grid, nothing else: no daily quick-mark
  // panel, no editable cells, no pay/salary info (already hidden elsewhere
  // by RBAC). Marking/editing attendance for anyone is still Manager+ only.
  if (!canManage) {
    return `
      <div class="grid">
        <section class="card">
          <h2 style="margin-top:0">ตารางเวลาประจำเดือน</h2>
          <form data-form="schedule-month-form" class="row">
            <label style="min-width:220px">
              เดือน
              <input type="month" name="month" value="${state.timesheetMonth}" />
            </label>
            <button class="btn" type="submit">ดู</button>
          </form>
          <div style="overflow-x:auto; margin-top:0.8rem;">${renderMonthlySchedule(staffList, false)}</div>
        </section>
      </div>
    `;
  }

  // Admin+ sees dailyRate/pay; Manager never does, even their own. See
  // CLAUDE.md's RBAC section.
  const showSalary = roleAtLeast('Admin');

  const rows = staffList.map((employee) => {
    const entry = getAttendanceForDate(employee.id, state.currentDate);
    const schedule = scheduleFor(state.currentDate);
    return `
      <div class="list-item">
        <div>
          <strong>${employee.name}</strong>
          <div class="muted">${employmentTypeLabel(employee.employmentType)} · ${roleLabel(employee.role)}${showSalary ? ` · ${formatCurrency(employee.dailyRate)}/วัน` : ''}</div>
          ${entry?.dayOff
            ? '<div class="small"><span class="badge overdue">วันหยุด</span></div>'
            : entry
              ? `<div class="small">เข้างาน ${entry.clockIn} · เลิกงาน ${entry.clockOut} · ทำงาน ${entry.workedHours} ชม. · มาสาย ${entry.lateMinutes} นาที${entry.pay !== null && showSalary ? ` · ค่าจ้าง ${formatCurrency(entry.pay)}` : ''}${entry.isHoliday ? ' · <span class="badge">วันหยุดนักขัตฤกษ์ x1.5</span>' : ''}${entry.closingDuty ? ' · <span class="badge">ปิดบิลแทน</span>' : ''}</div>`
              : `<div class="small">ยังไม่ได้ลงเวลาวันนี้ (ค่าเริ่มต้น: มาทำงานตามปกติ ${schedule.start}-${schedule.end})</div>`}
        </div>
        <div class="row">
          <input class="mini-input" type="time" value="${entry?.clockIn || schedule.start}" data-arrival-for="${employee.id}" />
          <button class="btn" data-action="mark-attendance" data-id="${employee.id}">บันทึกเข้างาน</button>
          <button class="btn secondary" data-action="clear-attendance" data-id="${employee.id}">ล้างข้อมูล</button>
          ${employee.role === 'Employee' ? `<button class="btn danger" data-action="delete-staff" data-id="${employee.id}">ลบพนักงาน</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">ภาพรวมการลงเวลา</h2>
        <form data-form="date-form" class="row">
          <label style="min-width:220px">
            เลือกวันที่
            <input type="date" name="date" value="${state.currentDate}" />
          </label>
          <button class="btn" type="submit">โหลดข้อมูล</button>
        </form>
      </section>
      <section class="card">
        <details>
          <summary class="schedule-daily-summary">พนักงาน วันที่ ${formatDate(state.currentDate)} (แตะเพื่อดู/แก้ไข)</summary>
          <div class="list" style="margin-top:0.8rem">${rows || '<p class="muted">ไม่มีข้อมูลให้แสดง</p>'}</div>
        </details>
      </section>
      <section class="card">
        <h2 style="margin-top:0">ตารางเวลาประจำเดือน</h2>
        <form data-form="schedule-month-form" class="row">
          <label style="min-width:220px">
            เดือน
            <input type="month" name="month" value="${state.timesheetMonth}" />
          </label>
          <button class="btn" type="submit">ดู</button>
        </form>
        <p class="muted small" style="margin-top:0.5rem">แตะที่ช่องเพื่อวางแผนหรือแก้ไขเวลาเข้า-ออกงานของแต่ละวัน ช่องสีแดงคือวันหยุด</p>
        <div style="overflow-x:auto; margin-top:0.8rem;">${renderMonthlySchedule(staffList)}</div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">สรุปผลประจำเดือน</h2>
        <div style="overflow-x:auto;">${renderScheduleSummary(staffList)}</div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">เพิ่มพนักงาน</h2>
          <form data-form="employee-form" class="stack">
            <div class="form-grid">
              <label>
                ชื่อ
                <input name="name" required />
              </label>
              <label>
                ตำแหน่ง
                <select name="role">
                  <option value="Employee">พนักงาน</option>
                  <option value="Manager">ผู้จัดการ</option>
                </select>
              </label>
              <label>
                ประเภทการจ้างงาน
                <select name="employmentType" required>
                  <option value="full-time">เต็มเวลา</option>
                  <option value="part-time">พาร์ทไทม์</option>
                </select>
              </label>
              ${showSalary ? `
                <label>
                  ค่าจ้างต่อวัน (฿)
                  <input name="dailyRate" type="number" min="0" value="380" required />
                </label>
              ` : ''}
              <label>
                รหัส PIN สำหรับเข้าสู่ระบบ
                <input name="pin" type="password" inputmode="numeric" required />
              </label>
            </div>
            ${!showSalary ? '<p class="muted small">ผู้จัดการเพิ่มพนักงานได้ แต่แอดมินหรือเจ้าของร้านต้องเป็นผู้ตั้งค่าจ้างต่อวันภายหลังในหน้าการเงิน</p>' : ''}
            <button class="btn" type="submit">เพิ่มพนักงาน</button>
            <p id="employee-form-error" class="error" hidden></p>
          </form>
        </section>
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

// One-time backfill for the Warehouse Analytics tab: historical stock-check
// readings transcribed from stock_data_1.md (checks from 5/4/69 to 23/7/69 —
// Thai Buddhist year 69 = 2026 CE), matched to warehouseItems by name. The
// 26/7 column is deliberately excluded since that value is already the live
// snapshot captured by STOCK_SEED_DATA/import-stock-seed — importing it again
// would just add a redundant zero-decline log entry. Items with no historical
// column in the file at all (e.g. น้ำจับเลี้ยง, first seen on 26/7) have no
// entry here — there's nothing to backfill. `null` marks a check where the
// file shows "-"/"—" (item not yet tracked at that point). Footnoted values
// (mid-period restocks, e.g. "80†") are recorded at their raw post-restock
// number like every other reading — computeStockInsight already only counts
// net declines between consecutive logs, so a period that nets an increase
// because of a mid-period restock is correctly skipped, same limitation the
// user's own by-hand analysis in stock_data_1.md already accepted.
const STOCK_HISTORY_DATES = [
  '2026-04-05', '2026-04-09', '2026-04-14', '2026-04-17', '2026-04-19', '2026-04-23', '2026-04-26', '2026-04-30',
  '2026-05-03', '2026-05-07', '2026-05-10', '2026-05-14', '2026-05-17', '2026-05-21', '2026-05-24', '2026-05-28', '2026-05-31',
  '2026-06-04', '2026-06-07', '2026-06-11', '2026-06-14', '2026-06-18', '2026-06-21', '2026-06-25', '2026-06-28',
  '2026-07-02', '2026-07-05', '2026-07-09', '2026-07-12', '2026-07-16', '2026-07-19', '2026-07-23'
];

const STOCK_HISTORY_DATA = [
  { name: 'ฟองเต้าหู้แห้ง แบบแท่ง', readings: [3, 3, 3, 2, 2, 2, 2, 1, 3, 2, 2, 0, 2, 0.5, 0, 2.5, 1, 0.5, 1.5, 1.5, 1, 3, 2, 1.5, 0, 2, 2, 1.1, 1, 3.5, 2, 2] },
  { name: 'ฟองเต้าหู้แห้ง เส้นเล็ก', readings: [3, 3, 4, 2.5, 2, 2.5, 3, 2, 2, 2, 2, 1, 3, 2, 1.1, 0.5, 2, 1.5, 0.5, 2.2, 2, 1, 0.5, 2, 1.5, 1, 2.5, 2, 1.5, 0.5, 0.1, 2] },
  { name: 'ฟองเต้าหู้ม้วน/ทอด', readings: [40, 32, 25, 22, 34, 32, 28, 21, 13, 32, 22, 44, 41, 32, 20, 43, 32, 19, 46, 35, 27, 27, 16, 44, 39, 29, 22, 15, 41, 33, 20, 44] },
  { name: 'บะหมี่ผัก มันม่วง', readings: [38, 32, 13, 5, 43, 30, 21, 18, 8, 80, 74, 64, 53, 37, 25, 15, 12, 61, 45, 38, 28, 14, 10, 80, 68, 61, 58, 45, 31, 19, 68, 49] },
  { name: 'เส้นหนึบ มันเทศ', readings: [59, 52, 46, 41, 34, 26, 22, 16, 12, 50, 46, 38, 30, 24, 16, 55, 53, 45, 38, 28, 70, 63, 54, 48, 40, 35, 32, 24, 19, 8, 0, 0] },
  { name: 'เส้นหนึบ ฟักทอง', readings: [11, 57, 49, 41, 34, 25, 19, 12, 7, 50, 36, 27, 20, 11, 4, 40, 42, 32, 24, 17, 55, 47, 38, 25, 16, 56, 52, 32, 21, 5, 0, 0] },
  { name: 'เส้นหนึบใหญ่', readings: [50, 67, 39, 36, 14, 81, 61, 27, 105, 119, 81, 80, 91, 103, 66, 75, 52, 55, 78, 95, 127, 99, 127, 103, 133, 127, 116, 146, 135, 165, 145, 192] },
  { name: 'เส้นหนึบกลมเล็ก', readings: [62, 55, 44, 31, 25, 13, 55, 47, 38, 26, 14, 64, 50, 39, 29, 63, 56, 43, 84, 71, 57, 95, 83, 75, 66, 57, 47, 36, 28, 69, 60, 52] },
  { name: 'เส้นอูด้ง', readings: [39, 27, 15, 9, 35, 24, 16, 39, 30, 20, 13, 33, 21, 14, 38, 23, 20, 27, 22, 8, 22, 37, 23, 7, 23, 11, 26, 13, 2, 11, 23, 6] },
  { name: 'เส้นดำ รากเฟิร์น', readings: [7, 6, 4, 3, 2, 1, 1, 3, 2, 2, 4, 3, 3, 1, 0, 7, 7, 4, 4, 3, 1, 20, 14, 11, 17, 16, 15, 14, 14, 13, 11, 10] },
  { name: 'เส้นราเมง', readings: [6, 32, 22, 18, 15, 9, 33, 25, 20, 9, 32, 27, 22, 16, 8, 0, 25, 16, 12, 37, 32, 26, 16, 11, 3, 28, 22, 16, 13, 0, 0, 26] },
  { name: 'สาหร่ายวากาเมะ', readings: [3, 2, 1, 1.2, 2.5, 1, 1, 3, 2, 2, 2, 1, 3, 3, 2.5, 1.5, 0.9, 2.5, 1.5, 2.5, 1, 3.5, 3, 3, 2, 2, 3, 3, 2.5, 2, 1.5, 0.8] },
  { name: 'ผักกุ๊งฉ่าย', readings: [3, 4, 4, 4, 3, 3, 3, 2, 3, 1.5, 2, 1, 1, 1.5, 0.5, 0, 0, 7, 6, 3, 1, 17, 16, 14, 13, 12, 11, 10, 10, 9, 9, 8] },
  { name: 'น้ำหวังเหล่าจี๋', readings: [8, 24, 21, 18, 13, 5, 23, 21, 15, 11, 32, 25, 16, 9, 26, 19, 18, 10, 5, 23, 16, 10, 2, 48, 44, 45, 33, 22, 22, 13, 7, 2] },
  { name: 'น้ำฟักเขียว', readings: [7, 28, 19, 16, 13, 9, 33, 32, 31, 29, 27, 25, 23, 20, 17, 13, 13, 10, 33, 29, 23, 19, 15, 12, 9, 28, 26, 23, 20, 18, 17, 14] },
  { name: 'นมแดง', readings: [10, 7, 0, 0, 10, 2, 10, 7, 5, 13, 6, 12, 9, 1, 13, 11, 11, 7, 0, 19, 14, 10, 7, 28, 25, 22, 20, 17, 14, 7, 6, 29] },
  { name: 'ชานมไต้หวัน', readings: [6, 1, 10, 7, 6, 3, 17, 15, 9, 5, 0, 30, 28, 27, 22, 11, 15, 8, 18, 18, 16, 16, 12, 10, 24, 21, 20, 20, 17, 7, 5, 15] },
  { name: 'ชาเขียวบ้วย', readings: [null, null, null, null, null, null, null, null, null, null, null, null, null, 5, 1, 0, null, 0, null, null, null, 11, 11, 25, 24, 20, 18, 16, 15, 11, 8, 2] },
  { name: 'ถ้วยน้ำจิ้ม 2 ออนซ์', readings: [23, 15, 28, 23, 25, 38, 36, 35, 52, 45, 39, 33, 27, 43, 36, 42, 27, 34, 37, 17, 25, 23, 16, 13, 12, 53, 48, 44, 42, 32, 31, 27] },
  { name: 'ถ้วยน้ำจิ้ม 1 ออนซ์', readings: [53, 16, 39, 54, 53, 50, 39, 46, 47, 47, 43, 42, 39, 36, 44, 34, 26, 24, 27, 25, 24, 21, 20, 18, 16, 15, 13, 11, 9, 46, 50, 54] },
  { name: 'กระดาษทิชชู่แบบแขวน', readings: [10, 8, 7, 6, 6, 10, 9, 8, 7, 6, 5, 4, 6, 7, 6, 4, 9, 8, 7, 16, 14, 11, 9, 7, 5, 2, 12, 10, 7, 14, 9, 5] },
  { name: 'กระดาษทิชชู่อันเล็ก', readings: [13, 10, 5, 2, 0, 38, 35, 32, 27, 22, 18, 13, 10, 40, 42, 31, 28, 25, 20, 51, 43, 37, 33, 29, 25, 23, 19, 15, 12, 44, 40, 36] },
  { name: 'กระดาษใบเสร็จ pos', readings: [29, 29, 10, 8, 7, 26, 13, 10, 8, 56, 54, 50, 30, 36, 44, 30, 30, 26, 25, 20, 18, 14, 12, 13, 9, 6, 14, 10, 10, 6, 4, 12] },
  { name: 'กระดาษใบเสร็จ grab 57x40', readings: [16, 13, 27, 26.5, 27, 14, 25, 25, 24, 22, 22, 20, 18, 14, 9, 14, 14, 13, 10, 10, 10, 8, 8, 7, 6, 8, 58, 57, 56, 55, 55, 54] },
  { name: 'ถ้วยอาหารพลาสติก 1,000ml', readings: [16, 14, 11, 5, 2, 36, 32, 27, 29, 23, 17, 18, 20, 8, 9, 21, 18, 26, 23, 15, 21, 20, 14, 15, 16, 26, 23, 19, 18, 13, 15, 9] },
  { name: 'เกี๊ยวกุ้งหมูสับ', readings: [3, 5, 3, 2, 1, 0, 3, 1, 2, 4, 3, 4, 3, 11, 11, 9, 6, 11, 11, 10, 8, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3] }
];

// Same methodology the user already uses by hand in their own stock-check
// notes: only count periods where quantity actually went down (a restock
// between checks would otherwise look like negative usage), average that
// into a per-day usage rate, then derive a reorder point (7 days of lead
// time + 30% safety margin) and a suggested order quantity (top up to 14
// days of cover). Needs at least two quantity log entries with a decline
// between them — fresh items show "not enough data yet" until then.
function computeStockInsight(item) {
  const logs = state.warehouseLogs
    .filter((log) => log.itemId === item.id)
    .sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || ''));
  let declineTotal = 0;
  let daysTotal = 0;
  for (let i = 1; i < logs.length; i++) {
    const prev = logs[i - 1];
    const curr = logs[i];
    const decline = Number(prev.quantity) - Number(curr.quantity);
    const days = (new Date(curr.recordedAt) - new Date(prev.recordedAt)) / (1000 * 60 * 60 * 24);
    if (decline > 0 && days > 0) {
      declineTotal += decline;
      daysTotal += days;
    }
  }
  if (daysTotal <= 0 || declineTotal <= 0) return { hasData: false };
  const usagePerDay = declineTotal / daysTotal;
  return {
    hasData: true,
    usagePerDay,
    daysLeft: Number(item.quantity) / usagePerDay,
    reorderPoint: usagePerDay * 7 * 1.3,
    suggestedOrder: Math.max(0, usagePerDay * 14 - Number(item.quantity))
  };
}

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
  const editMode = canManage && state.warehouseEditMode;
  const categories = Array.from(new Set(state.warehouseItems.map((item) => item.category || 'อื่นๆ')));
  const categoryOptions = categories.map((category) => `<option value="${category}"></option>`).join('');
  const groups = groupWarehouseItemsByCategory();

  const insights = state.warehouseItems.map((item) => ({ item, ...computeStockInsight(item) }));
  const withData = insights.filter((entry) => entry.hasData);
  const priorityItems = withData
    .filter((entry) => entry.daysLeft <= 14 || Number(entry.item.quantity) <= entry.reorderPoint)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const noDataCount = insights.length - withData.length;
  const priorityRows = priorityItems.map(({ item, usagePerDay, daysLeft, suggestedOrder }) => {
    const urgent = daysLeft <= 3;
    return `
      <div class="list-item">
        <div>
          <strong>${item.name}</strong>
          <div class="muted">ใช้วันละ ~${usagePerDay.toFixed(1)} ${item.unit} · เหลืออีก ~${Math.max(0, Math.floor(daysLeft))} วัน</div>
          ${suggestedOrder > 0 ? `<div class="small">แนะนำสั่งเพิ่ม ~${Math.ceil(suggestedOrder)} ${item.unit}</div>` : ''}
        </div>
        <span class="badge ${urgent ? 'overdue' : ''}">${urgent ? 'เร่งด่วน' : 'ควรเติมเร็วๆ นี้'}</span>
      </div>
    `;
  }).join('');

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
      <div class="stock-manage">
        <input class="mini-input" type="number" min="0" step="any" value="${item.quantity}" data-quantity-for="${item.id}" />
        <button class="btn secondary" data-action="update-item-quantity" data-id="${item.id}">อัปเดต</button>
        ${canManage && editMode ? `
          <input type="file" accept="image/*" data-image-for="${item.id}" />
          <button class="btn secondary" data-action="update-item-photo" data-id="${item.id}">${item.imageUrl ? 'เปลี่ยนรูป' : 'เพิ่มรูป'}</button>
        ` : ''}
        ${canManage ? `<button class="btn danger" data-action="delete-item" data-id="${item.id}">ลบ</button>` : ''}
      </div>
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
          <div class="row" style="justify-content:space-between">
            <h2 style="margin:0">คลังสินค้า</h2>
            <button class="btn ${editMode ? 'secondary' : ''}" data-action="toggle-warehouse-edit-mode">${editMode ? 'เสร็จสิ้นการแก้ไข' : 'แก้ไขคลังสินค้า'}</button>
          </div>
        </section>
      ` : ''}
      <section class="card">
        <h2 style="margin-top:0">ลำดับความสำคัญในการเติมสต็อก</h2>
        ${priorityItems.length ? `<div class="list">${priorityRows}</div>` : '<p class="muted">ทุกรายการมีสต็อกเพียงพอในตอนนี้</p>'}
        ${noDataCount ? `<p class="small muted" style="margin-top:0.6rem">${noDataCount} รายการยังไม่มีข้อมูลเพียงพอในการคำนวณ — ระบบจะเริ่มคำนวณอัตราการใช้หลังมีการอัปเดตจำนวนอย่างน้อย 2 ครั้ง</p>` : ''}
      </section>
      ${editMode ? `
        <section class="card">
          <h2 style="margin-top:0">เพิ่มสินค้า</h2>
          <form data-form="item-form" class="stack">
            <div class="form-grid">
              <label>
                หมวด
                <input name="category" list="category-options" placeholder="เช่น เครื่องดื่ม" required />
                <datalist id="category-options">${categoryOptions}</datalist>
              </label>
              <label>
                ชื่อสินค้า
                <input name="name" required />
              </label>
              <label>
                หน่วย
                <input name="unit" placeholder="กล่อง, ขวด, แพ็ค, กก." required />
              </label>
              <label>
                จำนวนคงเหลือ
                <input name="quantity" type="number" min="0" step="any" required />
              </label>
              <label>
                รูปภาพ
                <input name="image" type="file" accept="image/*" />
              </label>
            </div>
            <button class="btn" type="submit">เพิ่มสินค้า</button>
          </form>
        </section>
      ` : ''}
      ${editMode && state.warehouseItems.length === 0 ? `
        <section class="card">
          <h2 style="margin-top:0">นำเข้าข้อมูลสต็อกเก่า</h2>
          <p class="muted">นำเข้าสินค้า ${STOCK_SEED_DATA.length} รายการและหมวดหมู่จากใบเช็คสต็อกล่าสุด (26/7/69) ครั้งเดียว — ปุ่มนี้จะแสดงเฉพาะตอนที่คลังสินค้ายังว่างอยู่</p>
          <button class="btn secondary" data-action="import-stock-seed">นำเข้าจากใบเช็คสต็อก</button>
        </section>
      ` : ''}
      <section class="card">
        <h2 style="margin-top:0">ใบเช็คสต็อก</h2>
        <div class="stock-sheet">${sections || '<p class="muted">ยังไม่มีสินค้า</p>'}</div>
      </section>
    </div>
  `;
}

// Same as computeStockInsight, but every item instead of just the ones already
// low/urgent — this whole tab exists to show the full picture (everyone's
// days-left estimate side by side), where the Warehouse tab's own "restock
// priorities" section deliberately only surfaces the subset that needs
// attention right now.
function renderWarehouseAnalytics() {
  const canManage = roleAtLeast('Manager');
  // A one-time backfill guard, same idea as import-stock-seed's "only show
  // when the warehouse is empty" check — here, "has any log dated before the
  // live seed import" stands in for "history already imported," since there's
  // no separate flag/document tracking that.
  const historyImported = state.warehouseLogs.some((log) => log.recordedAt < '2026-05-01');

  const insights = state.warehouseItems
    .map((item) => ({ item, ...computeStockInsight(item) }))
    .sort((a, b) => {
      if (a.hasData && b.hasData) return a.daysLeft - b.daysLeft;
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return a.item.name.localeCompare(b.item.name, 'th');
    });

  const rows = insights.map(({ item, hasData, usagePerDay, daysLeft, reorderPoint, suggestedOrder }) => {
    const urgent = hasData && daysLeft <= 3;
    const warn = hasData && !urgent && daysLeft <= 14;
    return `
      <div class="list-item">
        <div>
          <strong>${item.name}</strong>
          <div class="muted">
            คงเหลือ ${item.quantity} ${item.unit}
            ${hasData
              ? ` · ใช้วันละ ~${usagePerDay.toFixed(1)} ${item.unit} · จุดสั่งซื้อ ~${reorderPoint.toFixed(1)} ${item.unit}`
              : ' · ยังไม่มีข้อมูลเพียงพอในการคำนวณ'}
          </div>
          ${hasData && suggestedOrder > 0 ? `<div class="small">แนะนำสั่งเพิ่ม ~${Math.ceil(suggestedOrder)} ${item.unit}</div>` : ''}
        </div>
        ${hasData
          ? `<span class="badge ${urgent ? 'overdue' : ''}">${warn || urgent ? `เหลืออีก ${Math.max(0, Math.floor(daysLeft))} วัน` : 'สต็อกเพียงพอ'}</span>`
          : '<span class="badge">ไม่มีข้อมูล</span>'}
      </div>
    `;
  }).join('');

  return `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">วิเคราะห์คลังสินค้า</h2>
        <p class="muted">
          คำนวณอัตราการใช้ต่อวันของแต่ละสินค้าจากประวัติการอัปเดตจำนวน แล้วประเมินว่าอีกกี่วันสินค้าจะหมด
          พร้อมจุดสั่งซื้อ (lead time 7 วัน + สำรอง 30%) และปริมาณแนะนำในการสั่งเพิ่ม (พอใช้ 14 วัน)
        </p>
        ${canManage && !historyImported ? `
          <button class="btn secondary" data-action="import-stock-history">นำเข้าประวัติสต็อกเก่า (เม.ย.-ก.ค. 69)</button>
        ` : ''}
      </section>
      <section class="card">
        <div class="list">${rows || '<p class="muted">ยังไม่มีสินค้าในคลัง</p>'}</div>
      </section>
    </div>
  `;
}

function renderRoutines() {
  const canManage = roleAtLeast('Manager');
  const rows = state.routines.map((routine) => {
    const status = getRoutineStatus(routine);
    const subtasks = routine.subtasks || [];
    const reports = state.routineInspections
      .filter((entry) => entry.routineId === routine.id)
      .sort((a, b) => (b.inspectedAt || '').localeCompare(a.inspectedAt || ''));

    const subtaskRows = subtasks.map((task) => `
      <label class="row" style="gap:0.5rem">
        <input type="checkbox" data-checklist-task="${routine.id}" data-task-id="${task.id}" />
        <span>${task.text}</span>
      </label>
    `).join('');

    const reportRows = reports.slice(0, 3).map((report) => {
      const staffName = state.staff.find((entry) => entry.id === report.staffId)?.name || 'ไม่ทราบชื่อ';
      const results = report.subtaskResults || [];
      const done = results.filter((task) => task.done).length;
      return `
        <div class="list-item">
          <div>
            <strong>${formatDate(report.inspectedAt)}</strong> · ${staffName}
            <div class="muted">${results.length ? `ทำเสร็จ ${done}/${results.length} งานย่อย` : 'ไม่มีงานย่อย'}${report.notes ? ` · ${report.notes}` : ''}</div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="list-item" style="flex-direction:column; align-items:stretch; gap:0.6rem;">
        <div class="row" style="justify-content:space-between">
          <div>
            <strong>${routine.name}</strong>
            <div class="muted">${frequencyLabel(routine)} · ทำครั้งล่าสุดเมื่อ ${formatDate(routine.lastInspectedAt)}</div>
            <div class="small">สถานะ: <span class="badge ${status === 'overdue' ? 'overdue' : ''}">${routineStatusLabel(status)}</span>${routine.timeOfDay ? ` <span class="badge">${TIME_OF_DAY_LABEL_TH[routine.timeOfDay] || routine.timeOfDay}</span>` : ''}</div>
          </div>
          ${canManage ? `<button class="btn danger" data-action="delete-routine" data-id="${routine.id}">ลบ</button>` : ''}
        </div>
        ${routine.description ? `<p class="small">${routine.description}</p>` : ''}
        ${routine.detail ? `<p class="small muted">${routine.detail}</p>` : ''}
        ${subtasks.length ? `<div class="stack">${subtaskRows}</div>` : '<p class="muted small">ไม่มีงานย่อย — ส่งรายงานได้เลยเมื่อทำเสร็จ</p>'}
        <label>
          หมายเหตุสำหรับรายงานนี้
          <textarea data-checklist-notes="${routine.id}" placeholder="หมายเหตุ (ถ้ามี)"></textarea>
        </label>
        <div class="row">
          <input type="file" accept="image/*" capture="environment" data-routine-image-for="${routine.id}" />
          <button class="btn" data-action="submit-checklist-report" data-id="${routine.id}">ส่งรายงาน</button>
        </div>
        ${routine.lastInspectedImageUrl ? `<img class="img-preview" src="${routine.lastInspectedImageUrl}" alt="${routine.name}" />` : ''}
        ${reportRows ? `<div class="stack"><h3 class="small" style="margin:0.25rem 0 0">รายงานล่าสุด</h3>${reportRows}</div>` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="grid">
      ${canManage ? `
        <section class="card">
          <h2 style="margin-top:0">สร้างเช็คลิสต์</h2>
          <form data-form="routine-form" class="stack">
            <div class="form-grid">
              <label>
                ชื่อเช็คลิสต์
                <input name="name" required />
              </label>
              <label>
                ความถี่ (วัน) — ใช้เมื่อไม่ได้เลือกวันในสัปดาห์ด้านล่าง
                <input name="frequencyDays" type="number" min="1" value="7" />
              </label>
            </div>
            <label>
              หรือทำเฉพาะวันในสัปดาห์ (เลือกแล้วจะใช้แทนความถี่ด้านบน)
              <div class="row">
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="1" /> จ</label>
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="2" /> อ</label>
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="3" /> พ</label>
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="4" /> พฤ</label>
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="5" /> ศ</label>
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="6" /> ส</label>
                <label class="row" style="gap:0.3rem"><input type="checkbox" name="weekday" value="0" /> อา</label>
              </div>
            </label>
            <label>
              ช่วงเวลา (ถ้ามี)
              <select name="timeOfDay">
                <option value="">ไม่ระบุ</option>
                <option value="before-open">ก่อนเปิดร้าน</option>
                <option value="after-close">หลังปิดร้าน</option>
              </select>
            </label>
            <label>
              คำอธิบาย
              <input name="description" placeholder="สรุปสั้นๆ" />
            </label>
            <label>
              รายละเอียด / คำแนะนำ
              <textarea name="detail" placeholder="คำแนะนำโดยละเอียดสำหรับผู้ทำเช็คลิสต์นี้"></textarea>
            </label>
            <label>
              งานย่อย (บรรทัดละ 1 งาน)
              <textarea name="subtasks" placeholder="ตรวจอุณหภูมิตู้เย็น&#10;เช็ดทำความสะอาดโต๊ะ"></textarea>
            </label>
            <button class="btn" type="submit">สร้างเช็คลิสต์</button>
          </form>
        </section>
      ` : ''}
      <section class="card">
        <h2 style="margin-top:0">เช็คลิสต์ทั้งหมด</h2>
        <div class="list">${rows || '<p class="muted">ยังไม่มีเช็คลิสต์</p>'}</div>
      </section>
    </div>
  `;
}

function renderAdmin() {
  const rows = state.staff.map((person) => `
    <div class="list-item">
      <div>
        <strong>${person.name}</strong>
        <div class="muted">${roleLabel(person.role)}${person.employmentType ? ` · ${employmentTypeLabel(person.employmentType)} · ${formatCurrency(person.dailyRate)}/วัน` : ''}</div>
      </div>
      ${person.role !== 'App Owner' ? `
        <div class="row">
          <button class="btn secondary" data-action="edit-staff" data-id="${person.id}">แก้ไข</button>
          <button class="btn danger" data-action="delete-staff" data-id="${person.id}">ลบสิทธิ์การเข้าถึง</button>
        </div>
      ` : ''}
    </div>
  `).join('');

  return `
    <div class="grid">
      <section class="card">
        <h2 style="margin-top:0">จัดการผู้ดูแลระบบ</h2>
        <p class="muted">การลบสิทธิ์จะลบเฉพาะโปรไฟล์ในแอป — บัญชีเข้าสู่ระบบเดิมไม่สามารถลบถาวรได้จากเบราว์เซอร์ ดังนั้นพนักงานที่ถูกลบจะไม่มีโปรไฟล์ให้เข้าสู่ระบบได้อีกต่อไป</p>
        <form data-form="staff-form" class="stack">
          <div class="form-grid">
            <label>
              ชื่อ
              <input name="name" required />
            </label>
            <label>
              ตำแหน่ง
              <select name="role">
                <option value="App Owner">เจ้าของร้าน</option>
                <option value="Admin">แอดมิน</option>
                <option value="Manager">ผู้จัดการ</option>
                <option value="Employee">พนักงาน</option>
              </select>
            </label>
            <label>
              ประเภทการจ้างงาน (เฉพาะพนักงาน)
              <select name="employmentType">
                <option value="">ไม่มี</option>
                <option value="full-time">เต็มเวลา</option>
                <option value="part-time">พาร์ทไทม์</option>
              </select>
            </label>
            <label>
              ค่าจ้างต่อวัน (฿, เฉพาะพนักงาน)
              <input name="dailyRate" type="number" min="0" value="380" />
            </label>
            <label>
              รหัส PIN สำหรับเข้าสู่ระบบ
              <input name="pin" type="password" inputmode="numeric" required />
            </label>
          </div>
          <button class="btn" type="submit">เพิ่มบัญชี</button>
          <p id="staff-form-error" class="error" hidden></p>
        </form>
      </section>
      <section class="card">
        <h2 style="margin-top:0">รายชื่อและตำแหน่ง</h2>
        <div class="list">${rows}</div>
      </section>
    </div>
  `;
}

// Days up to and including today use the actual attendance record's pay (or
// 0 if the employee wasn't marked present); days after today assume on-time
// attendance at the employee's day rate, since the app has no concept of a
// fixed weekly schedule to know which future days someone is actually rostered.
// Default assumption (agreed with the user): everyone works their normal
// schedule every day of the month unless a manager explicitly marked that
// day off via the schedule grid — a day with no record at all is NOT
// treated as unpaid absence, past or future, it's assumed worked on-time.
function computeExpectedSalary(employee, monthValue) {
  let total = 0;
  let workedDays = 0;
  let offDays = 0;
  datesInMonth(monthValue).forEach((dateStr) => {
    const record = getAttendanceForDate(employee.id, dateStr);
    if (record?.dayOff) {
      offDays++;
    } else if (record) {
      total += Number(record.pay || 0);
      workedDays++;
    } else {
      total += calculateDailyPay(employee.dailyRate, 0, isHolidayDate(dateStr));
      workedDays++;
    }
  });
  return { total, workedDays, offDays };
}

function renderFinancial() {
  const paidStaff = state.staff.filter((person) => person.employmentType);
  const salaries = paidStaff.map((employee) => ({ employee, ...computeExpectedSalary(employee, state.financialMonth) }));
  const grandTotal = salaries.reduce((sum, entry) => sum + entry.total, 0);

  const rows = salaries.map(({ employee, total, workedDays, offDays }) => `
    <div class="list-item" style="flex-direction:column; align-items:stretch; gap:0.5rem;">
      <div class="row" style="justify-content:space-between">
        <div>
          <strong>${employee.name}</strong>
          <div class="muted">${employmentTypeLabel(employee.employmentType)} · ${roleLabel(employee.role)}</div>
          <div class="small">${workedDays} วันทำงาน, ${offDays} วันหยุด</div>
        </div>
        <strong>${formatCurrency(total)}</strong>
      </div>
      <div class="row">
        <input class="mini-input" type="number" min="0" value="${employee.dailyRate ?? 0}" data-rate-for="${employee.id}" />
        <span class="muted small">฿/วัน</span>
        <button class="btn secondary" data-action="update-employee-rate" data-id="${employee.id}">อัปเดตค่าจ้าง</button>
      </div>
    </div>
  `).join('');

  const holidayRows = state.holidays.map((holiday) => `
    <div class="list-item">
      <div>
        <strong>${formatDate(holiday.date)}</strong>
        ${holiday.name ? `<div class="muted">${holiday.name}</div>` : ''}
      </div>
      <button class="btn danger" data-action="delete-holiday" data-id="${holiday.id}">ลบ</button>
    </div>
  `).join('');

  return `
    <div class="grid">
      <section class="card">
        <div class="row" style="justify-content:space-between">
          <h2 style="margin:0">การเงิน — เงินเดือนที่คาดการณ์</h2>
          <span class="badge">รวม ${formatCurrency(grandTotal)}</span>
        </div>
        <form data-form="financial-period-form" class="row" style="margin-top:0.8rem">
          <label style="min-width:220px">
            เดือน
            <input type="month" name="month" value="${state.financialMonth}" />
          </label>
          <button class="btn" type="submit">ดูข้อมูล</button>
        </form>
        <p class="muted small" style="margin-top:0.5rem">ระบบสมมติว่าพนักงานมาทำงานตามปกติทุกวัน ยกเว้นวันที่ผู้จัดการทำเครื่องหมายว่าเป็นวันหยุดในตารางเวลา หากมีการลงเวลาจริง (เช่น มาสาย) ระบบจะใช้ข้อมูลจริงแทน</p>
      </section>
      <section class="card">
        <h2 style="margin-top:0">เงินเดือนที่คาดการณ์ต่อพนักงาน</h2>
        <div class="list">${rows || '<p class="muted">ยังไม่มีพนักงานที่รับค่าจ้าง</p>'}</div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">วันหยุดนักขัตฤกษ์ (จ่าย 1.5 เท่า)</h2>
        <form data-form="holiday-form" class="row">
          <label style="min-width:180px">
            วันที่
            <input type="date" name="date" required />
          </label>
          <label style="min-width:180px">
            ชื่อวันหยุด
            <input name="name" placeholder="เช่น สงกรานต์" />
          </label>
          <button class="btn secondary" type="submit">เพิ่มวันหยุด</button>
        </form>
        <div class="list" style="margin-top:0.8rem">${holidayRows || '<p class="muted">ยังไม่มีวันหยุดที่เพิ่ม</p>'}</div>
      </section>
    </div>
  `;
}

function renderNotifications() {
  return `
    <div class="grid">
      <section class="card">
        <div class="row">
          <h2 style="margin:0">การแจ้งเตือน</h2>
          <button class="btn secondary" data-action="mark-all-read">ทำเครื่องหมายว่าอ่านแล้วทั้งหมด</button>
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
          `).join('') : '<p class="muted">ยังไม่มีการแจ้งเตือน</p>'}
        </div>
      </section>
    </div>
  `;
}

// Every delete action requires confirming twice in a row (two separate
// native confirm() prompts) rather than once — deletes in this app are
// permanent (no undo, no trash/recycle bin), so this is deliberately more
// friction than a typical single "are you sure?".
function confirmDeleteTwice(message) {
  return confirm(message) && confirm(`ยืนยันอีกครั้ง: ${message}`);
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
  // Clicking the darkened backdrop itself (not the modal card, which is a
  // child and would otherwise bubble up to this same click) closes the modal.
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.onclick = (event) => {
      if (event.target === backdrop) handleAction(backdrop.dataset.closeAction, {});
    };
  });
}

// Auth account creation and the Firestore staff-doc write happen as two
// separate steps (createStaffMember below) with no rollback between them —
// if the doc write fails after the Auth account already succeeded, that
// Auth login is now orphaned (no staff doc) and its email is permanently
// taken, so retrying with the exact same name will always fail here with
// auth/email-already-in-use. Surfacing the real reason (instead of previously
// failing silently with no feedback at all) is what lets someone notice and
// pick a different name, or ask an Admin to delete the orphaned login from
// the Firebase console.
function showStaffFormError(elementId, error) {
  const el = document.querySelector(`#${elementId}`);
  if (!el) return;
  const messages = {
    'auth/email-already-in-use': 'ชื่อนี้เคยถูกใช้สร้างบัญชีมาก่อน (แม้จะเคยลบพนักงานนั้นออกไปแล้วก็ตาม) กรุณาใช้ชื่ออื่น หรือแจ้งแอดมินให้ลบบัญชีเดิมออกจาก Firebase console',
    'auth/weak-password': 'รหัส PIN สั้นเกินไป ต้องมีอย่างน้อย 6 ตัวอักษร',
    'auth/invalid-email': 'ไม่สามารถสร้างชื่อผู้ใช้จากชื่อนี้ได้ กรุณาลองใช้ชื่ออื่น',
    'permission-denied': 'ไม่มีสิทธิ์เพิ่มบัญชีนี้'
  };
  el.textContent = messages[error?.code] || `เกิดข้อผิดพลาด: ${error?.message || 'ไม่ทราบสาเหตุ'}`;
  el.hidden = false;
}

async function createStaffMember(formData) {
  const name = formData.get('name');
  const role = formData.get('role');
  const employmentType = formData.get('employmentType') || '';
  const dailyRate = employmentType ? Number(formData.get('dailyRate') || 0) : null;
  const pin = formData.get('pin');
  const uid = await DB.createStaffAuthAccount(name, pin);
  const record = {
    id: uid,
    name,
    role,
    employmentType,
    dailyRate,
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
    try {
      const employee = await createStaffMember(formData);
      await pushNotification('เพิ่มพนักงานแล้ว', `${employee.name} พร้อมใช้งานในระบบลงเวลาแล้ว`);
      render();
    } catch (error) {
      showStaffFormError('employee-form-error', error);
    }
    return;
  }

  if (name === 'staff-form') {
    if (!roleAtLeast('Admin')) return;
    try {
      const person = await createStaffMember(formData);
      await pushNotification('เพิ่มบัญชีผู้ดูแลแล้ว', `${person.name} ได้รับสิทธิ์ ${roleLabel(person.role)} แล้ว`);
      render();
    } catch (error) {
      showStaffFormError('staff-form-error', error);
    }
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
    const log = { id: DB.uid('wlog'), itemId: item.id, quantity: item.quantity, recordedAt: nowISO() };
    await DB.put('warehouseLogs', log);
    upsertLocal('warehouseLogs', log);
    await pushNotification('เพิ่มสินค้าคลังแล้ว', `${item.name} ถูกเพิ่มเข้าระบบติดตามสต็อกแล้ว`);
    render();
    return;
  }

  if (name === 'routine-form') {
    if (!roleAtLeast('Manager')) return;
    const subtasks = (formData.get('subtasks') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ id: DB.uid('task'), text }));
    const weekdays = formData.getAll('weekday').map(Number);
    const routine = {
      id: DB.uid('routine'),
      name: formData.get('name'),
      description: formData.get('description') || '',
      detail: formData.get('detail') || '',
      timeOfDay: formData.get('timeOfDay') || '',
      subtasks,
      weekdays,
      frequencyDays: Number(formData.get('frequencyDays') || 7),
      lastInspectedAt: nowISO(),
      lastInspectedImageUrl: '',
      createdAt: nowISO()
    };
    await DB.put('routines', routine);
    upsertLocal('routines', routine);
    await pushNotification('สร้างเช็คลิสต์แล้ว', `${routine.name} — ${frequencyLabel(routine)}`);
    render();
    return;
  }

  if (name === 'financial-period-form') {
    if (!roleAtLeast('Admin')) return;
    state.financialMonth = formData.get('month') || monthISO();
    render();
    return;
  }

  if (name === 'holiday-form') {
    if (!roleAtLeast('Admin')) return;
    const holiday = {
      id: DB.uid('holiday'),
      date: formData.get('date'),
      name: formData.get('name') || '',
      createdAt: nowISO()
    };
    await DB.put('holidays', holiday);
    upsertLocal('holidays', holiday);
    render();
    return;
  }

  if (name === 'date-form') {
    state.currentDate = formData.get('date') || todayISO();
    render();
  }

  if (name === 'schedule-month-form') {
    // No role gate — this only changes which month is being viewed (an
    // Employee's own read-only monthly schedule included), it never writes.
    state.timesheetMonth = formData.get('month') || monthISO();
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
    const isHoliday = isHolidayDate(state.currentDate);
    const closingDuty = getAttendanceForDate(employee.id, state.currentDate)?.closingDuty === true;
    const pay = calculateDailyPay(employee.dailyRate, lateMinutes, isHoliday, closingDuty);
    const record = {
      id: attendanceId(employee.id, state.currentDate),
      staffId: employee.id,
      date: state.currentDate,
      clockIn: roundedArrival,
      clockOut: schedule.end,
      lateMinutes,
      workedHours,
      pay,
      isHoliday,
      dayOff: false,
      closingDuty,
      updatedBy: state.currentUser?.uid || '',
      createdAt: nowISO()
    };
    await DB.put('attendance', record);
    upsertLocal('attendance', record);
    await pushNotification('บันทึกเวลาทำงานแล้ว', `${state.currentStaff?.name || ''} บันทึกเวลาทำงานของ ${employee.name} วันที่ ${formatDate(state.currentDate)}`);
    render();
    return;
  }

  if (action === 'clear-attendance') {
    if (!roleAtLeast('Manager')) return;
    const employee = state.staff.find((entry) => entry.id === data.id);
    const id = attendanceId(data.id, state.currentDate);
    await DB.del('attendance', id);
    removeLocal('attendance', id);
    await pushNotification('ล้างข้อมูลเวลาทำงาน', `${state.currentStaff?.name || ''} ล้างข้อมูลเวลาทำงานของ ${employee?.name || ''} วันที่ ${formatDate(state.currentDate)}`);
    render();
    return;
  }

  if (action === 'select-schedule-cell') {
    if (!roleAtLeast('Manager')) return;
    state.selectedScheduleCell = { staffId: data.staffId, date: data.date };
    render();
    return;
  }

  if (action === 'close-schedule-cell') {
    state.selectedScheduleCell = null;
    render();
    return;
  }

  if (action === 'save-schedule-cell') {
    if (!roleAtLeast('Manager')) return;
    if (!state.selectedScheduleCell) return;
    const { staffId, date } = state.selectedScheduleCell;
    const employee = state.staff.find((entry) => entry.id === staffId);
    if (!employee) return;
    const clockIn = document.querySelector('#schedule-on-input')?.value;
    const clockOut = document.querySelector('#schedule-off-input')?.value;
    if (!clockIn || !clockOut) return;
    const schedule = scheduleFor(date);
    const lateMinutes = Math.max(0, toMinutes(clockIn) - toMinutes(schedule.start));
    const workedHours = Math.max(0, (toMinutes(clockOut) - toMinutes(clockIn)) / 60 - 1);
    const isHoliday = isHolidayDate(date);
    const closingDuty = getAttendanceForDate(staffId, date)?.closingDuty === true;
    const pay = calculateDailyPay(employee.dailyRate, lateMinutes, isHoliday, closingDuty);
    const record = {
      id: attendanceId(employee.id, date),
      staffId: employee.id,
      date,
      clockIn,
      clockOut,
      lateMinutes,
      workedHours,
      pay,
      isHoliday,
      dayOff: false,
      closingDuty,
      updatedBy: state.currentUser?.uid || '',
      createdAt: nowISO()
    };
    await DB.put('attendance', record);
    upsertLocal('attendance', record);
    state.selectedScheduleCell = null;
    await pushNotification('อัปเดตตารางเวลา', `${state.currentStaff?.name || ''} ตั้งเวลาเข้า-ออกงานของ ${employee.name} วันที่ ${formatDate(date)} เป็น ${clockIn}-${clockOut}`);
    render();
    return;
  }

  if (action === 'mark-schedule-dayoff') {
    if (!roleAtLeast('Manager')) return;
    if (!state.selectedScheduleCell) return;
    const { staffId, date } = state.selectedScheduleCell;
    const employee = state.staff.find((entry) => entry.id === staffId);
    if (!employee) return;
    const record = {
      id: attendanceId(staffId, date),
      staffId,
      date,
      dayOff: true,
      clockIn: null,
      clockOut: null,
      lateMinutes: 0,
      workedHours: 0,
      pay: 0,
      isHoliday: false,
      closingDuty: false,
      updatedBy: state.currentUser?.uid || '',
      createdAt: nowISO()
    };
    await DB.put('attendance', record);
    upsertLocal('attendance', record);
    state.selectedScheduleCell = null;
    await pushNotification('อัปเดตตารางเวลา', `${state.currentStaff?.name || ''} ทำเครื่องหมายวันหยุดให้ ${employee.name} วันที่ ${formatDate(date)}`);
    render();
    return;
  }

  if (action === 'toggle-closing-duty') {
    if (!roleAtLeast('Manager')) return;
    if (!state.selectedScheduleCell) return;
    const { staffId, date } = state.selectedScheduleCell;
    const employee = state.staff.find((entry) => entry.id === staffId);
    if (!employee) return;
    const existing = getAttendanceForDate(staffId, date);
    const schedule = scheduleFor(date);
    const closingDuty = !(existing?.closingDuty === true);
    const clockIn = existing?.clockIn || schedule.start;
    const clockOut = existing?.clockOut || schedule.end;
    const lateMinutes = existing?.lateMinutes || 0;
    const isHoliday = isHolidayDate(date);
    const pay = calculateDailyPay(employee.dailyRate, lateMinutes, isHoliday, closingDuty);
    const record = {
      id: attendanceId(staffId, date),
      staffId,
      date,
      dayOff: false,
      clockIn,
      clockOut,
      lateMinutes,
      workedHours: existing?.workedHours || 0,
      pay,
      isHoliday,
      closingDuty,
      updatedBy: state.currentUser?.uid || '',
      createdAt: nowISO()
    };
    await DB.put('attendance', record);
    upsertLocal('attendance', record);
    state.selectedScheduleCell = null;
    await pushNotification(
      'อัปเดตตารางเวลา',
      `${state.currentStaff?.name || ''} ${closingDuty ? 'มอบหมายให้' : 'ยกเลิกการมอบหมายให้'} ${employee.name} ปิดบิลแทนวันที่ ${formatDate(date)}`
    );
    render();
    return;
  }

  if (action === 'clear-schedule-cell') {
    if (!roleAtLeast('Manager')) return;
    if (!state.selectedScheduleCell) return;
    const { staffId, date } = state.selectedScheduleCell;
    const employee = state.staff.find((entry) => entry.id === staffId);
    const id = attendanceId(staffId, date);
    await DB.del('attendance', id);
    removeLocal('attendance', id);
    state.selectedScheduleCell = null;
    await pushNotification('อัปเดตตารางเวลา', `${state.currentStaff?.name || ''} ยกเลิกวันหยุดของ ${employee?.name || ''} วันที่ ${formatDate(date)} (กลับมาทำงานตามปกติ)`);
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

  if (action === 'toggle-warehouse-edit-mode') {
    if (!roleAtLeast('Manager')) return;
    state.warehouseEditMode = !state.warehouseEditMode;
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
      const log = { id: DB.uid('wlog'), itemId: item.id, quantity: item.quantity, recordedAt: nowISO() };
      await DB.put('warehouseLogs', log);
      upsertLocal('warehouseLogs', log);
    }
    await pushNotification('นำเข้าข้อมูลสต็อกแล้ว', `นำเข้าสินค้า ${STOCK_SEED_DATA.length} รายการจากใบเช็คสต็อกวันที่ 26/7/69`);
    render();
    return;
  }

  if (action === 'import-stock-history') {
    if (!roleAtLeast('Manager')) return;
    let importedCount = 0;
    for (const entry of STOCK_HISTORY_DATA) {
      const item = state.warehouseItems.find((candidate) => candidate.name === entry.name);
      if (!item) continue;
      for (let i = 0; i < STOCK_HISTORY_DATES.length; i++) {
        const quantity = entry.readings[i];
        if (quantity === null || quantity === undefined) continue;
        const log = {
          id: DB.uid('wlog'),
          itemId: item.id,
          quantity,
          recordedAt: new Date(`${STOCK_HISTORY_DATES[i]}T00:00:00.000Z`).toISOString()
        };
        await DB.put('warehouseLogs', log);
        upsertLocal('warehouseLogs', log);
        importedCount += 1;
      }
    }
    await pushNotification('นำเข้าประวัติสต็อกแล้ว', `นำเข้าประวัติการเช็คสต็อก ${importedCount} รายการ (เม.ย.-ก.ค. 69) เพื่อคำนวณอัตราการใช้ย้อนหลัง`);
    render();
    return;
  }

  if (action === 'update-item-quantity') {
    if (!roleAtLeast('Employee')) return;
    const item = state.warehouseItems.find((entry) => entry.id === data.id);
    if (!item) return;
    const input = document.querySelector(`[data-quantity-for="${data.id}"]`);
    const quantity = Math.max(0, Number(input?.value ?? item.quantity));
    const record = { ...item, quantity };
    try {
      await DB.put('warehouseItems', record);
      upsertLocal('warehouseItems', record);
      const log = { id: DB.uid('wlog'), itemId: item.id, quantity, recordedAt: nowISO() };
      await DB.put('warehouseLogs', log);
      upsertLocal('warehouseLogs', log);
      await pushNotification('อัปเดตจำนวนสินค้า', `${state.currentStaff?.name || ''} ปรับจำนวน ${item.name} เป็น ${quantity} ${item.unit}`);
    } catch (error) {
      // Without this, a rejected write (e.g. stale Firestore console rules)
      // failed silently: render() never ran, so the input kept showing the
      // just-typed number even though nothing was actually saved — looked
      // like it worked locally but never reached Firestore for anyone else.
      console.error('update-item-quantity failed', error);
      alert('บันทึกจำนวนไม่สำเร็จ: ' + (error.message || error));
    }
    render();
    return;
  }

  if (action === 'update-item-photo') {
    if (!roleAtLeast('Manager')) return;
    const item = state.warehouseItems.find((entry) => entry.id === data.id);
    if (!item) return;
    const imageInput = document.querySelector(`[data-image-for="${data.id}"]`);
    const file = imageInput?.files?.[0];
    if (!file) return;
    const imageUrl = await fileToCompressedDataUrl(file);
    const record = { ...item, imageUrl };
    await DB.put('warehouseItems', record);
    upsertLocal('warehouseItems', record);
    render();
    return;
  }

  if (action === 'delete-item') {
    if (!roleAtLeast('Manager')) return;
    const item = state.warehouseItems.find((entry) => entry.id === data.id);
    if (!confirmDeleteTwice(`ต้องการลบ "${item?.name || ''}" ออกจากคลังสินค้าใช่หรือไม่?`)) return;
    await DB.del('warehouseItems', data.id);
    removeLocal('warehouseItems', data.id);
    render();
    return;
  }

  if (action === 'delete-routine') {
    if (!roleAtLeast('Manager')) return;
    const routine = state.routines.find((entry) => entry.id === data.id);
    if (!confirmDeleteTwice(`ต้องการลบเช็คลิสต์ "${routine?.name || ''}" ใช่หรือไม่?`)) return;
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
    if (!confirmDeleteTwice(`ต้องการลบสิทธิ์การเข้าถึงของ "${person.name}" ใช่หรือไม่?`)) return;
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

  if (action === 'submit-checklist-report') {
    const routine = state.routines.find((entry) => entry.id === data.id);
    if (!routine) return;
    const imageInput = document.querySelector(`[data-routine-image-for="${data.id}"]`);
    const file = imageInput?.files?.[0];
    const newImageUrl = file ? await fileToCompressedDataUrl(file) : '';
    const notesInput = document.querySelector(`[data-checklist-notes="${data.id}"]`);
    const notes = notesInput?.value.trim() || '';
    const subtaskResults = (routine.subtasks || []).map((task) => {
      const checkbox = document.querySelector(`[data-checklist-task="${data.id}"][data-task-id="${task.id}"]`);
      return { id: task.id, text: task.text, done: !!checkbox?.checked };
    });
    const updatedRoutine = {
      ...routine,
      lastInspectedAt: nowISO(),
      lastInspectedImageUrl: newImageUrl || routine.lastInspectedImageUrl || ''
    };
    await DB.put('routines', updatedRoutine);
    upsertLocal('routines', updatedRoutine);
    const report = {
      id: DB.uid('report'),
      routineId: routine.id,
      staffId: state.currentUser?.uid || '',
      imageUrl: newImageUrl,
      notes,
      subtaskResults,
      inspectedAt: nowISO()
    };
    await DB.put('routineInspections', report);
    upsertLocal('routineInspections', report);
    await pushNotification('ส่งรายงานเช็คลิสต์แล้ว', `ทำ ${routine.name} เสร็จเรียบร้อยแล้ว`);
    render();
    return;
  }

  if (action === 'delete-holiday') {
    if (!roleAtLeast('Admin')) return;
    const holiday = state.holidays.find((entry) => entry.id === data.id);
    if (!confirmDeleteTwice(`ต้องการลบวันหยุด "${formatDate(holiday?.date)}${holiday?.name ? ` (${holiday.name})` : ''}" ใช่หรือไม่?`)) return;
    await DB.del('holidays', data.id);
    removeLocal('holidays', data.id);
    render();
    return;
  }

  if (action === 'update-employee-rate') {
    if (!roleAtLeast('Admin')) return;
    const employee = state.staff.find((entry) => entry.id === data.id);
    if (!employee) return;
    const input = document.querySelector(`[data-rate-for="${data.id}"]`);
    const dailyRate = Math.max(0, Number(input?.value ?? employee.dailyRate ?? 0));
    const record = { ...employee, dailyRate };
    await DB.put('staff', record);
    upsertLocal('staff', record);
    await pushNotification('อัปเดตค่าจ้าง', `${state.currentStaff?.name || ''} ปรับค่าจ้างต่อวันของ ${employee.name} เป็น ${formatCurrency(dailyRate)}`);
    render();
    return;
  }

  if (action === 'edit-staff') {
    if (!roleAtLeast('Admin')) return;
    const person = state.staff.find((entry) => entry.id === data.id);
    if (!person || person.role === 'App Owner') return;
    state.editingStaffId = data.id;
    render();
    return;
  }

  if (action === 'close-staff-edit') {
    state.editingStaffId = null;
    render();
    return;
  }

  if (action === 'save-staff-edit') {
    if (!roleAtLeast('Admin')) return;
    const person = state.staff.find((entry) => entry.id === state.editingStaffId);
    if (!person || person.role === 'App Owner') return;
    const name = document.querySelector('#staff-edit-name')?.value.trim();
    const role = document.querySelector('#staff-edit-role')?.value;
    const employmentType = document.querySelector('#staff-edit-employment-type')?.value || '';
    const dailyRateInput = document.querySelector('#staff-edit-daily-rate')?.value;
    if (!name || !role) return;
    const dailyRate = employmentType ? Math.max(0, Number(dailyRateInput ?? person.dailyRate ?? 0)) : null;
    const record = { ...person, name, role, employmentType, dailyRate };
    await DB.put('staff', record);
    upsertLocal('staff', record);
    state.editingStaffId = null;
    await pushNotification('แก้ไขข้อมูลพนักงานแล้ว', `${state.currentStaff?.name || ''} แก้ไขข้อมูลของ ${name}`);
    render();
    return;
  }

  if (action === 'open-change-pin') {
    state.showChangePinModal = true;
    render();
    return;
  }

  if (action === 'close-change-pin') {
    state.showChangePinModal = false;
    render();
    return;
  }

  if (action === 'submit-change-pin') {
    const errorEl = document.querySelector('#change-pin-error');
    const showError = (message) => {
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.hidden = false;
      }
    };
    const currentPin = document.querySelector('#current-pin-input')?.value || '';
    const newPin = document.querySelector('#new-pin-input')?.value || '';
    const confirmPin = document.querySelector('#confirm-pin-input')?.value || '';
    if (newPin !== confirmPin) {
      showError('รหัส PIN ใหม่ทั้งสองช่องไม่ตรงกัน');
      return;
    }
    if (newPin.length < 6) {
      showError('รหัส PIN ใหม่ต้องมีอย่างน้อย 6 หลัก');
      return;
    }
    try {
      await DB.changePassword(currentPin, newPin);
      state.showChangePinModal = false;
      await pushNotification('เปลี่ยนรหัส PIN แล้ว', `${state.currentStaff?.name || ''} เปลี่ยนรหัส PIN ของตัวเองแล้ว`);
      render();
    } catch (error) {
      const messages = {
        'auth/wrong-password': 'รหัส PIN ปัจจุบันไม่ถูกต้อง',
        'auth/weak-password': 'รหัส PIN ใหม่สั้นเกินไป ต้องมีอย่างน้อย 6 หลัก',
        'auth/requires-recent-login': 'เซสชันเก่าเกินไป กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ก่อนเปลี่ยนรหัส PIN',
        'auth/too-many-requests': 'พยายามหลายครั้งเกินไป กรุณาลองใหม่ภายหลัง'
      };
      showError(messages[error?.code] || `เกิดข้อผิดพลาด: ${error?.message || 'ไม่ทราบสาเหตุ'}`);
    }
    return;
  }
}

document.addEventListener('DOMContentLoaded', initAuthGate);

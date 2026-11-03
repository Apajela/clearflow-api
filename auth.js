const ITERATIONS = 310000;
const SESSION_HOURS = 12;

function toBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function verifyPassword(password, storedHash) {
  try {
    const [algorithm, iterations, saltValue, expectedValue] =
      storedHash.split("$");

    if (algorithm !== "pbkdf2" || Number(iterations) !== ITERATIONS) {
      return false;
    }

    const calculated = await hashPassword(
      password,
      fromBase64(saltValue)
    );

const actual = fromBase64(calculated.split("$")[3]);
const expected = fromBase64(expectedValue);

if (actual.length !== expected.length) return false;

let difference = 0;

for (let i = 0; i < actual.length; i++) {
  difference |= actual[i] ^ expected[i];
}

return difference === 0;

  } catch {
    return false;
  }
}

function safeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i];
  }

  return difference === 0;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sessionCookie(token, maxAge = SESSION_HOURS * 3600) {
  return `cf_session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return "cf_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0";
}

function getSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";

  const match = cookie.match(/(?:^|;\s*)cf_session=([^;]+)/);

  return match ? match[1] : null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    role: user.role,
    department: user.department,
    isFullAccess: user.is_full_access,
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    avatarUrl: user.avatar_url,
    lastLogin: user.last_login
  };
}

export async function login(db, username, password) {
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.trim().length < 3 ||
    username.length > 100 ||
    password.length < 1 ||
    password.length > 256
  ) {
    return null;
  }

  const result = await db.query(
    `SELECT *
     FROM app_users
     WHERE LOWER(username) = LOWER($1)
       AND is_active = TRUE
     LIMIT 1`,
    [username.trim()]
  );

  const user = result.rows[0];

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return null;
  }

  const token = createToken();
  const tokenHash = await sha256(token);

  await db.query(
    `INSERT INTO auth_sessions
       (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '12 hours')`,
    [user.id, tokenHash]
  );

  const updated = await db.query(
    `UPDATE app_users
     SET last_login = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [user.id]
  );

  return {
    user: publicUser(updated.rows[0]),
    cookie: sessionCookie(token)
  };
}

export async function authenticate(db, request) {
const token = getSessionToken(request);

if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  return null;
}
  const tokenHash = await sha256(token);

const result = await db.query(
    `SELECT u.*
     FROM auth_sessions s
     JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > NOW()
       AND s.revoked_at IS NULL
       AND u.is_active = TRUE
     LIMIT 1`,
    [tokenHash]
  );

  const user = result.rows[0];

  return user ? publicUser(user) : null;
}

export async function logout(db, request) {
  const token = getSessionToken(request);

  if (token) {
    const tokenHash = await sha256(token);

    await db.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW()
       WHERE token_hash = $1
         AND revoked_at IS NULL`,
      [tokenHash]
    );
  }

  return clearSessionCookie();
}

export function hasPermission(user, permission) {
  if (!user || typeof permission !== "string") {
    return false;
  }

  if (user.is_full_access === true || user.isFullAccess === true) {
    return true;
  }

  const permissions = Array.isArray(user.permissions)
    ? user.permissions
    : [];

  return permissions.includes(permission);
}
export async function verifyCurrentPassword(db, userId, password) {
  if (
    typeof userId !== "string" ||
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 256
  ) {
    return false;
  }

  const result = await db.query(
    `SELECT password_hash
     FROM app_users
     WHERE id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [userId]
  );

  const user = result.rows[0];

  if (!user) {
    return false;
  }

  return await verifyPassword(password, user.password_hash);
}

export async function bootstrapFirstAdmin(db, input) {
  const {
    bootstrapToken,
    expectedToken,
    username,
    password,
    fullName,
    email = "",
    department = ""
  } = input || {};

  if (
    typeof bootstrapToken !== "string" ||
    typeof expectedToken !== "string" ||
    bootstrapToken.length < 32 ||
    !safeTokenEqual(bootstrapToken, expectedToken) ||
    typeof username !== "string" ||
    username.trim().length < 3 ||
    username.length > 100 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256 ||
    typeof fullName !== "string" ||
    fullName.trim().length < 2 ||
    fullName.length > 200 ||
    typeof email !== "string" ||
    email.length > 255 ||
    typeof department !== "string" ||
    department.length > 150
  ) {
    throw new Error("Invalid administrator bootstrap request");
  }

  await db.query("BEGIN");

  try {
    await db.query(
      "SELECT pg_advisory_xact_lock($1)",
      [82461001]
    );

    const count = await db.query(
      "SELECT COUNT(*)::int AS total FROM app_users"
    );

    if (count.rows[0].total !== 0) {
      throw new Error("Administrator bootstrap is already closed");
    }

    const duplicate = await db.query(
      "SELECT 1 FROM app_users WHERE LOWER(username) = LOWER($1) LIMIT 1",
      [username.trim()]
    );

    if (duplicate.rows.length > 0) {
      throw new Error("Username is already in use");
    }

    const passwordHash = await hashPassword(password);

    const result = await db.query(
      `INSERT INTO app_users
        (username, password_hash, full_name, email, department,
         role, is_active, is_full_access, permissions)
       VALUES ($1, $2, $3, $4, $5, 'Administrator', TRUE, TRUE, '[]'::jsonb)
       RETURNING id, username, full_name, email, department,
                 role, is_active, is_full_access, permissions`,
      [
        username.trim(),
        passwordHash,
        fullName.trim(),
        email.trim(),
        department.trim()
      ]
    );

    await db.query("COMMIT");

    return publicUser(result.rows[0]);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

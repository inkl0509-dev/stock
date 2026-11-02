// Main admins: these emails always get the Admin button and can edit lists
// (Counted in, Categories, Places, Suppliers, Outlets, Breakage reasons).
// Put the SAME emails in firestore.rules (isAdmin) so Firebase allows the changes.
// To manage USERS (add / delete logins) you also need the Vercel setup in README.md.
export const ADMIN_EMAILS = [
  "iirufan@gmail.com"
];

export const isAdminEmail = email => !!email && ADMIN_EMAILS.map(e => e.trim().toLowerCase()).includes(String(email).toLowerCase());

// Onside School config — the one place to flip the pilot open and to hold the transfer account.

// While false, /school (page + nav link) stays owner-only (is_admin). Flip to true to open the
// story + record + join flow to every signed-in user. Paid members always see the upcoming pick.
export const SCHOOL_OPEN = false;

// Monthly price shown on the join screen and pre-filled as the receipt amount.
export const SCHOOL_PRICE = 10000; // ₦ / month

// Transfer account shown to paying users.
export const SCHOOL_BANK = {
  bank: "Moniepoint",
  account: "6612407443",
  name: "Thinka Platforms Ltd",
};

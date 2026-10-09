/**
 * merchantRules.js
 *
 * Free categorization: a list of well-known merchants and keywords, checked on
 * every imported transaction. No AI call and no cost. Anything that doesn't
 * match stays Uncategorized for the user (or a later AI step) to sort out.
 *
 * Matches are saved with categorySource "rule" and confidence 0.9 (above the
 * 0.7 review line, but below the 1.0 of a user's own choice or a card payment,
 * because a keyword can occasionally be wrong).
 *
 * Order matters: the first match wins, so specific patterns come before
 * general ones (UBER EATS before UBER, AMAZON PRIME before AMAZON).
 */
"use strict";

const RULE_CONFIDENCE = 0.9;

// [category, pattern]. Patterns are matched against the merchant text in upper case.
const RULES = [
  // ---- Income (only ever applied to money coming in; see categorizeMerchant)
  ["income", /\b(PAYROLL|DIRECT DEP(OSIT)?|DIR DEP|SALARY|PAYCHECK|INTEREST PAID|INTEREST PAYMENT)\b/],

  // ---- Specific before general
  ["dining", /\b(UBER\s*\*?\s*EATS|DOORDASH|GRUBHUB|POSTMATES)\b/],
  ["subscriptions", /\b(AMAZON PRIME|PRIME VIDEO|AMZN PRIME|APPLE\.COM\/BILL|ICLOUD|GOOGLE \*?(STORAGE|ONE|YOUTUBE)|YOUTUBE (PREMIUM|TV))\b/],

  // ---- Subscriptions and software
  ["subscriptions", /\b(NETFLIX|SPOTIFY|HULU|DISNEY ?PLUS|HBO ?MAX|MAX\.COM|PARAMOUNT|PEACOCK|AUDIBLE|ADOBE|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|MICROSOFT\s*\*?\s*365|DROPBOX|PATREON|SIRIUSXM|DUOLINGO|NYTIMES|CRUNCHYROLL)\b/],

  // ---- Dining
  ["dining", /\b(STARBUCKS|DUNKIN|MCDONALD'?S|BURGER KING|WENDY'?S|TACO BELL|CHIPOTLE|CHICK-?FIL-?A|SUBWAY|PANERA|DOMINO'?S|PIZZA HUT|PAPA JOHN'?S|LITTLE CAESARS|SONIC DRIVE|ARBY'?S|FIVE GUYS|JIMMY JOHN'?S|JERSEY MIKE'?S|POPEYES|KFC|DAIRY QUEEN|OLIVE GARDEN|APPLEBEE'?S|CHILI'?S|TEXAS ROADHOUSE|BUFFALO WILD|RAISING CANE'?S|WHATABURGER|IN-N-OUT|SHAKE SHACK|SWEETGREEN|NOODLES|QDOBA|CULVER'?S|KONA GRILL|BLUE BOTTLE|PEET'?S|TIM HORTONS|CAFE|COFFEE|PIZZA|TACO|GRILL|BISTRO|KITCHEN|DINER|RESTAURANT|BBQ|SUSHI|BAKERY)\b/],

  // ---- Groceries
  ["groceries", /\b(ALDI|KROGER|HY-?VEE|TRADER JOE'?S|WHOLE FOODS|WHOLEFDS|SAFEWAY|PUBLIX|WEGMANS|H-E-B|HEB|MEIJER|FOOD LION|GIANT EAGLE|SPROUTS|SCHNUCKS|DILLONS|PRICE CHOPPER|WINCO|COSTCO|SAM'?S CLUB|WAL-?MART|WALMART|INSTACART|GROCERY|MARKET|SUPERMARKET)\b/],

  // ---- Transportation
  ["transportation", /\b(UBER|LYFT|SHELL|EXXON|MOBIL|CHEVRON|BP|SPEEDWAY|QUIKTRIP|CASEY'?S|CIRCLE K|SUNOCO|CITGO|VALERO|MARATHON|PHILLIPS 66|KWIK TRIP|WAWA|SHEETZ|PARKING|PARKMOBILE|TOLL|METRO|TRANSIT|AMTRAK|JIFFY LUBE|AUTOZONE|O'?REILLY AUTO|GAS STATION|FUEL)\b/],

  // ---- Utilities and phone/internet
  ["utilities", /\b(EVERGY|AMEREN|DUKE ENERGY|XCEL|SPIRE|ATMOS|CON ED|PG&E|ELECTRIC|WATER|GAS CO|ENERGY|UTILIT(Y|IES)|COMCAST|XFINITY|SPECTRUM|COX COMM|AT&T|VERIZON|T-MOBILE|TMOBILE|GOOGLE FIBER|CENTURYLINK|INTERNET|WIRELESS)\b/],

  // ---- Health
  ["health", /\b(CVS|WALGREENS|RITE AID|PHARMACY|DENTAL|DENTIST|CLINIC|HOSPITAL|MEDICAL|DOCTOR|OPTOMETR|VISION|URGENT CARE|LABCORP|QUEST DIAG|PLANET FITNESS|GYM|FITNESS|YMCA)\b/],

  // ---- Entertainment
  ["entertainment", /\b(AMC|REGAL|CINEMA|THEATRE|THEATER|MOVIES?|BOWLERO|BOWLING|STEAM|PLAYSTATION|XBOX|NINTENDO|TICKETMASTER|STUBHUB|EVENTBRITE|DAVE ?& ?BUSTER'?S|TOPGOLF|CONCERT|MUSEUM|ZOO|ARCADE)\b/],

  // ---- Shopping (general retail last, after the more specific stores above)
  ["shopping", /\b(AMAZON|AMZN|TARGET|BEST BUY|IKEA|HOME DEPOT|LOWE'?S|ETSY|EBAY|KOHL'?S|MACY'?S|NORDSTROM|TJ ?MAXX|MARSHALLS|ROSS|OLD NAVY|GAP|H&M|ZARA|NIKE|ADIDAS|SEPHORA|ULTA|BATH & BODY|DOLLAR (TREE|GENERAL)|FAMILY DOLLAR|MICHAELS|HOBBY LOBBY|PETSMART|PETCO|CHEWY|APPLE STORE|SHEIN|TEMU|WAYFAIR)\b/],
];

/**
 * The category for a merchant from the keyword list, or null if nothing matches.
 *
 * @param {string} merchant  Description from the statement
 * @param {number} amount    Negative = money out, positive = money in
 * @returns {{category: string, categoryConfidence: number, categorySource: "rule"}|null}
 */
function categorizeMerchant(merchant, amount) {
  const text = String(merchant || "").toUpperCase();
  for (const [category, pattern] of RULES) {
    // A "payroll" line going out (paying someone else) isn't your income
    if (category === "income" && !(amount > 0)) continue;
    if (pattern.test(text)) {
      return { category, categoryConfidence: RULE_CONFIDENCE, categorySource: "rule" };
    }
  }
  return null;
}

module.exports = { categorizeMerchant, RULE_CONFIDENCE };

// Rule-based auto-tagging: looks at the dish name (known dishes -> cuisine + main
// ingredients) and at the ingredient list (proteins, cheese, cuisine hints).
// Runs fully offline, so tagging works without any API key.

export const CATEGORIES = [
  'Mains', 'Baking', 'Desserts', 'Soups & Salads', 'Breakfast', 'Snacks & Sides', 'Drinks', 'Other',
];

const CUISINES = new Set([
  'Italian', 'French', 'Spanish', 'Greek', 'Middle Eastern', 'North African', 'Indian', 'Chinese',
  'Japanese', 'Korean', 'Thai', 'Vietnamese', 'Filipino', 'Southeast Asian', 'Mexican',
  'Latin American', 'American', 'British', 'German', 'Eastern European', 'Caribbean', 'West African',
]);

// --- Known dishes, matched against the entry name -------------------------------------------
const DISHES = [
  // Italian
  [/bolognese/, ['Italian', 'Beef', 'Pork', 'Cheese', 'Pasta', 'Tomato']],
  [/\brag[uùú]\b/, ['Italian', 'Tomato']], // ragù can be any meat; the rest of the name decides
  [/\bduck\b|confit de canard|peking duck/, ['Duck']],
  [/\blamb\b|\bmutton\b/, ['Lamb']],
  [/carbonara/, ['Italian', 'Pork', 'Egg', 'Cheese', 'Pasta']],
  [/amatriciana/, ['Italian', 'Pork', 'Cheese', 'Pasta', 'Tomato']],
  [/cacio e pepe/, ['Italian', 'Cheese', 'Pasta']],
  [/lasagn[ae]/, ['Italian', 'Beef', 'Cheese', 'Pasta', 'Tomato']],
  [/risotto/, ['Italian', 'Rice', 'Cheese']],
  [/pizza|margherita|calzone/, ['Italian', 'Cheese', 'Bread']],
  [/tiramis[uù]/, ['Italian', 'Coffee', 'Cheese']],
  [/panna cotta|biscotti|cannoli|affogato/, ['Italian']],
  [/focaccia|ciabatta|grissini/, ['Italian', 'Bread']],
  [/gnocchi/, ['Italian', 'Potato']],
  [/pesto/, ['Italian', 'Cheese', 'Nuts']],
  [/minestrone|caprese|bruschetta|frittata|aglio e olio|puttanesca|arrabbiata|cacciatore|saltimbocca|piccata/, ['Italian']],
  [/osso buco/, ['Italian', 'Beef']],
  [/parmigiana|chicken parm/, ['Italian', 'Cheese', 'Tomato']],
  [/arancini/, ['Italian', 'Rice', 'Cheese']],
  [/\b(spaghetti|penne|fettuccine|tagliatelle|linguine|rigatoni|ravioli|tortellini|pappardelle|fusilli|farfalle|bucatini|orecchiette)\b/, ['Italian', 'Pasta']],
  // French
  [/croissant|pain au chocolat|brioche|baguette/, ['French', 'Bread']],
  [/quiche/, ['French', 'Egg', 'Cheese']],
  [/coq au vin/, ['French', 'Chicken']],
  [/bourguignon/, ['French', 'Beef']],
  [/ratatouille|bouillabaisse|cr[eê]pes?\b|souffl[eé]|cassoulet|macarons?\b|madeleines?|tarte tatin|cr[eè]me br[uû]l[eé]e|gratin|[eé]clairs?|profiteroles?|croque|ni[cç]oise|confit|b[eé]chamel|galette|clafoutis/, ['French']],
  // Spanish / Latin
  [/paella/, ['Spanish', 'Rice', 'Seafood']],
  [/gazpacho|patatas bravas|tapas|croquetas|crema catalana|alb[oó]ndigas|tortilla espa/, ['Spanish']],
  [/churros?/, ['Spanish', 'Mexican']],
  [/\b(tacos?|burritos?|enchiladas?|quesadillas?|fajitas?|nachos|guacamole|salsa|tamales?|pozole|chilaquiles|elote|mole|tostadas?|al pastor|birria|carnitas|huevos rancheros)\b/, ['Mexican']],
  [/carnitas|al pastor/, ['Pork']],
  [/birria/, ['Beef']],
  [/ceviche|empanadas?|chimichurri|arepas?|brigadeiros?|feijoada|p[aã]o de queijo|lomo saltado|dulce de leche/, ['Latin American']],
  [/\bjerk\b|ackee|oxtail stew/, ['Caribbean']],
  [/jollof|suya|egusi/, ['West African']],
  // Greek / Middle East / North Africa
  [/moussaka|souvlaki|gyros?\b|tzatziki|spanakopita|baklava|greek salad|dolmades|pastitsio|avgolemono/, ['Greek']],
  [/hummus|falafel|shawarma|tabbouleh|baba ganoush|shakshuka|kebabs?\b|kofta|fattoush|labneh|manakish|halloumi|mujadara/, ['Middle Eastern']],
  [/tagine|couscous|harissa|chermoula/, ['North African']],
  // South Asia
  [/butter chicken|tikka|masala|biryani|korma|vindaloo|\bdaa?l\b|dhal|tandoori|paneer|\bnaan\b|samosas?|chana|\baloo\b|palak|rogan josh|pakoras?|raita|chapati|parathas?|dosas?|\bidli\b|jalfrezi|saag/, ['Indian']],
  [/paneer/, ['Cheese', 'Vegetarian']],
  // East Asia
  [/pad thai/, ['Thai', 'Noodles', 'Egg', 'Nuts']],
  [/green curry|red curry|massaman|panang|tom yum|tom kha|\blarb\b|som tam|pad see ew|pad kra pao|khao soi|mango sticky rice/, ['Thai']],
  [/tom yum/, ['Seafood', 'Spicy']],
  [/\b(ramen|udon|soba)\b/, ['Japanese', 'Noodles']],
  [/sushi|\bmaki\b|nigiri|onigiri/, ['Japanese', 'Rice', 'Fish']],
  [/teriyaki|katsu|tempura|okonomiyaki|\bmiso\b|gyoza|yakitori|donburi|oyakodon|karaage|takoyaki|matcha|mochi|dorayaki|japanese/, ['Japanese']],
  [/tonkatsu/, ['Pork']],
  [/oyakodon|karaage|yakitori/, ['Chicken']],
  [/kimchi|bibimbap|bulgogi|japchae|tteokbokki|gochujang|kimbap|galbi|sundubu|korean/, ['Korean']],
  [/bulgogi|galbi/, ['Beef']],
  [/fried rice|chow mein|lo mein|kung pao|mapo|dumplings?|\bbao\b|char siu|wontons?|dim sum|sweet and sour|hot pot|congee|xiao long bao|dan dan|peking|chinese|egg tart|mooncake/, ['Chinese']],
  [/char siu|xiao long bao|sweet and sour pork/, ['Pork']],
  [/mapo/, ['Tofu', 'Pork', 'Spicy']],
  [/kung pao/, ['Chicken', 'Nuts', 'Spicy']],
  [/peking duck/, ['Duck']],
  [/\bpho\b|banh mi|b[aá]nh m[iì]|bun cha|goi cuon|vietnamese/, ['Vietnamese']],
  [/\bpho\b/, ['Beef', 'Noodles']],
  [/adobo|sinigang|lumpia|pancit|kare[- ]kare|sisig|leche flan|ube/, ['Filipino']],
  [/laksa|nasi lemak|rendang|satay|\bsate\b|nasi goreng|mee goreng|mee siam|char kway teow|hainanese|chicken rice|bak kut teh|roti prata|roti canai|\bkaya\b|chilli crab|chili crab|ondeh|kueh|kuih|\botah\b|lontong|sambal|gado gado|pandan|cendol|rojak|hokkien mee|bee hoon|curry puff/, ['Southeast Asian']],
  [/laksa|chilli crab|chili crab|char kway teow|hokkien mee/, ['Seafood']],
  [/rendang|bak kut teh/, ['Beef']],
  [/bak kut teh/, ['Pork']],
  // British / American / Europe
  [/fish and chips|fish & chips/, ['British', 'Fish', 'Potato']],
  [/shepherd'?s pie/, ['British', 'Lamb', 'Potato']],
  [/cottage pie/, ['British', 'Beef', 'Potato']],
  [/sunday roast|yorkshire pudding|scones?\b|bangers|full english|sticky toffee|trifle|crumble|beef wellington|toad in the hole|victoria sponge|eton mess|bread and butter pudding|past(y|ies)|crumpets?|flapjacks?|shortbread|hot cross buns?/, ['British']],
  [/burgers?\b|mac and cheese|mac ?n'? ?cheese|meatloaf|\bbbq\b|barbecue|pulled pork|cornbread|buffalo wings?|hot dogs?|brownies?|chocolate chip cookies?|pancakes?|cheesecake|apple pie|pot roast|clam chowder|biscuits and gravy|coleslaw|sloppy joe|banana bread|cinnamon rolls?|pumpkin pie|pecan pie|s'?mores|blondies?|doughnuts?|donuts?|waffles?|chili con carne/, ['American']],
  [/schnitzel|strudel|pretzels?|bratwurst|sauerkraut|sp[aä]etzle|black forest|stollen/, ['German']],
  [/goulash|pierogi|borscht|stroganoff|blini|cabbage rolls|paprikash/, ['Eastern European']],

  // Main-ingredient hints from dish names
  [/\b(burgers?|meatloaf|pot roast|wellington|stroganoff|goulash|steak|brisket|chili con carne|meatballs?|beef)\b/, ['Beef']],
  [/\b(rogan josh|lamb|mutton)\b/, ['Lamb']],
  [/pulled pork|bratwurst|bangers|toad in the hole|sisig|\bham\b|bacon|\bpork\b|sausages?|n['’]?duja|guanciale|pancetta|prosciutto|chorizo|mortadella|norcina|zozzona|lup cheong|char siu|siu yuk|dong ?po|卤肉|东坡/, ['Pork']],
  [/chicken|tandoori|coq au vin|\bjerk\b|buffalo wings?|satay/, ['Chicken']],
  [/\b(fish|salmon|tuna|cod|sushi|ceviche|bouillabaisse|otah|ni[cç]oise|sardines?|mackerel|trout|sea bass|snapper)\b/, ['Fish']],
  [/\b(prawns?|shrimps?|crabs?|lobster|scallops?|mussels?|clams?|squid|calamari|oysters?|seafood|clam chowder)\b/, ['Seafood']],
  [/mac and cheese|mac ?n'? ?cheese|quesadillas?|cheesecake|gratin|croque|enchiladas?|nachos|spanakopita|souffl[eé]|cheese/, ['Cheese']],
  [/chocolate|brownies?|black forest|brigadeiros?|fudge|mocha|cocoa/, ['Chocolate']],
  [/\b(pasta|macaroni|orzo|mac and cheese)\b/, ['Pasta']],
  [/noodles?|\bmee\b|kway teow|bee hoon|vermicelli|laksa|chow mein|lo mein|japchae|khao soi/, ['Noodles']],
  [/\brice\b|biryani|congee|bibimbap|donburi|\bnasi\b|jollof/, ['Rice']],
  [/\beggs?\b|omelet(te)?|frittata|shakshuka|eggs benedict|egg tart/, ['Egg']],
  [/tofu|sundubu/, ['Tofu']],
  [/mushrooms?/, ['Mushroom']],
  [/\b(sourdough|bread|loaf|buns?|bagels?|rolls)\b/, ['Bread']],
  [/\bvegan\b/, ['Vegan', 'Vegetarian']],
  [/vegetarian|veggie/, ['Vegetarian']],
  [/spicy|chilli|chili|sambal|vindaloo|jalape[nñ]o|sriracha|gochujang|buffalo/, ['Spicy']],
  [/curry/, ['Curry']],
  [/coconut/, ['Coconut']],
  [/lemon|lime/, ['Citrus']],
];

// --- Ingredient-line patterns -------------------------------------------------------------
const INGREDIENT_TAGS = [
  ['Beef', /\b(beef|steaks?|brisket|sirloin|rib-?eye|chuck|oxtail|veal|short ribs?)\b/],
  ['Pork', /\b(pork|bacon|pancetta|guanciale|prosciutto|ham|chorizo|sausages?|salami|lardons?|pepperoni|char siu|spare ?ribs|lap cheong|n['’]?duja|mortadella|speck)\b/],
  ['Chicken', /\bchicken\b(?! (stock|broth|bouillon|powder))/],
  ['Turkey', /\bturkey\b/],
  ['Duck', /\bduck\b/],
  ['Lamb', /\b(lamb|mutton)\b/],
  ['Fish', /\b(fish(?! sauce)|salmon|tuna|cod|anchov(y|ies)|sardines?|mackerel|halibut|tilapia|trout|sea ?bass|snapper|haddock|barramundi)\b/],
  ['Seafood', /\b(shrimps?(?! paste)|prawns?|crabs?|lobsters?|scallops?|mussels?|clams?|squid(?! ink)|calamari|oysters?(?! sauce)|octopus)\b/],
  ['Egg', /\beggs?\b|\begg (yolks?|whites?)\b/],
  ['Cheese', /\b(cheese|parmesan|parmigiano|mozzarella|cheddar|ricotta|feta|gruy[eè]re|pecorino|mascarpone|brie|gouda|halloumi|paneer|gorgonzola|burrata|emmental|manchego|cotija|cream cheese)\b/],
  ['Chocolate', /\b(chocolate|cocoa|cacao)\b/],
  ['Tofu', /\btofu\b/],
  ['Mushroom', /\b(mushrooms?|shiitake|porcini|chanterelles?|enoki|portobello)\b/],
  ['Pasta', /\b(pasta|spaghetti|penne|fettuccine|tagliatelle|linguine|rigatoni|macaroni|orzo|lasagne|lasagna|ravioli|tortellini|pappardelle|fusilli|farfalle|bucatini)\b/],
  ['Noodles', /\bnoodles?\b|\bvermicelli\b/],
  ['Rice', /\brice\b(?!\s*(vinegar|wine|flour|paper|noodles?|cakes?))|\b(arborio|basmati)\b/],
  ['Nuts', /\b(almonds?(?! (milk|extract))|walnuts?(?! oil)|pecans?|cashews?|hazelnuts?|pistachios?|peanuts?(?! oil)|peanut butter|macadamias?|pine nuts)\b/],
  ['Coconut', /\bcoconut\b/],
  ['Spicy', /\b(chill?i(es)? (flakes|peppers?|padi)|bird'?s eye|jalape[nñ]os?|habaneros?|cayenne|sriracha|gochujang|gochugaru|sambal|scotch bonnet)\b/],
  ['Potato', /\bpotato(es)?\b/],
];

// Ingredients that hint at a cuisine. Two distinct hits are needed before we tag it.
const CUISINE_HINTS = [
  ['Indian', /\b(garam masala|curry leaves|ghee|paneer|asafoetida|hing|fenugreek|methi|kasuri|amchur|chaat masala|cardamom|turmeric)\b/g],
  ['Japanese', /\b(mirin|dashi|miso|nori|bonito|katsuobushi|sake|kombu|shichimi|furikake|japanese)\b/g],
  ['Korean', /\b(gochujang|gochugaru|kimchi|doenjang|korean)\b/g],
  ['Thai', /\b(galangal|kaffir|makrut|thai basil|lemongrass|fish sauce|(red|green|yellow) curry paste|palm sugar)\b/g],
  ['Mexican', /\b(tortillas?|jalape[nñ]os?|chipotle|cotija|queso fresco|masa harina|ancho|poblano|tomatillos?|cilantro)\b/g],
  ['Chinese', /\b(shaoxing|oyster sauce|hoisin|doubanjiang|five[- ]spice|sichuan pepper|dark soy|black vinegar|chinkiang|light soy)\b/g],
  ['Italian', /\b(parmigiano|parmesan|pecorino|mozzarella|pancetta|guanciale|prosciutto|arborio|mascarpone|ricotta|balsamic|basil)\b/g],
  ['Greek', /\b(feta|kalamata|tzatziki|oregano|filo|phyllo)\b/g],
  ['Middle Eastern', /\b(tahini|sumac|za'?atar|pomegranate molasses|bulgur|baharat|chickpeas?)\b/g],
  ['Southeast Asian', /\b(belacan|candlenuts?|pandan|laksa|sambal|kecap manis|gula melaka|tamarind|calamansi|daun kesum|lemongrass)\b/g],
  ['French', /\b(gruy[eè]re|cr[eè]me fra[iî]che|dijon|herbes de provence|shallots?|tarragon|cognac)\b/g],
];

export const MEAT_TAGS = ['Beef', 'Pork', 'Chicken', 'Turkey', 'Duck', 'Lamb', 'Fish', 'Seafood'];
export const isCuisineTag = (t) => CUISINES.has(t);

// --- Category guess ------------------------------------------------------------------------
const DRINKS_RULE = ['Drinks', /smoothie|cocktail|latte|lemonade|\btea\b|coffee|milkshake|juice|mocktail|sangria|kombucha|bubble tea|boba|teh tarik|punch\b/];
const CATEGORY_RULES = [
  ['Breakfast', /pancakes?|waffles?|omelet(te)?|granola|oatmeal|porridge|overnight oats|french toast|eggs benedict|scrambled eggs|breakfast|full english|huevos rancheros|kaya toast/],
  ['Baking', /cakes?\b|cookies?|brownies?|blondies?|muffins?|cupcakes?|bread|loaf|\bpie\b|\btart\b|tarts\b|scones?|croissants?|focaccia|brioche|baguette|sourdough|biscuits?|buns?\b|rolls?\b|pastry|pastries|macarons?|madeleines?|cinnamon rolls?|bagels?|pretzels?|shortbread|financiers?|galette|strudel|babka|banana bread|cheesecake|[eé]clairs?|danish|focaccia|swiss roll|chiffon|bake\b|baked goods/],
  ['Desserts', /ice cream|gelato|sorbet|pudding|mousse|tiramis[uù]|panna cotta|cr[eè]me br[uû]l[eé]e|custard|trifle|crumble|cobbler|parfait|dessert|fudge|truffles?|mochi|cendol|leche flan|sticky toffee|churros?|eton mess|pavlova|affogato|sweet soup|tong sui|jelly/],
  DRINKS_RULE, // after baking/desserts so "coffee walnut cake" is a cake, not a drink
  ['Soups & Salads', /soup|stew|chowder|bisque|broth|salad|gazpacho|minestrone|borscht|congee|laksa|\bpho\b|ramen|tom yum|tom kha|slaw|coleslaw/],
  ['Snacks & Sides', /dip\b|hummus|guacamole|salsa|fries|chips|wings?\b|spring rolls?|dumplings?|samosas?|nachos|bruschetta|side\b|appetizer|snack|popcorn|crackers?|pickles?|kimchi|edamame|croquetas|arancini|curry puffs?|garlic bread|coleslaw|roasted vegetables|mashed potato/],
];

export function guessCategory(name = '', ingredients = []) {
  const n = name.toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(n)) return cat;
  // Flour + sugar + butter/eggs and no meat => probably baking.
  const text = ingredients.join(' \n ').toLowerCase();
  if (/\bflour\b/.test(text) && /\bsugar\b/.test(text) && /\b(butter|eggs?|baking (powder|soda)|yeast)\b/.test(text)
      && !INGREDIENT_TAGS.filter(([t]) => MEAT_TAGS.includes(t)).some(([, re]) => re.test(text))) {
    return 'Baking';
  }
  return 'Mains';
}

// --- Main entry point ------------------------------------------------------------------------
/**
 * @param {{name?: string, ingredients?: string[], hints?: string[]}} input
 *   hints: extra tags from an imported recipe (e.g. schema.org recipeCuisine)
 * @returns {string[]} ordered: cuisines first, then main ingredients, then the rest
 */
export function suggestTags({ name = '', ingredients = [], hints = [] } = {}) {
  const tags = new Set();
  const n = name.toLowerCase();

  for (const [re, add] of DISHES) if (re.test(n)) add.forEach((t) => tags.add(t));

  const lines = ingredients.map((l) => String(l).toLowerCase());
  const text = lines.join(' \n ');
  for (const [tag, re] of INGREDIENT_TAGS) if (lines.some((l) => re.test(l))) tags.add(tag);

  // Cuisine from ingredients only when the name gave us none.
  if (![...tags].some((t) => CUISINES.has(t))) {
    let best = null;
    for (const [cuisine, re] of CUISINE_HINTS) {
      const hits = new Set(text.match(re) || []).size;
      if (hits >= 2 && (!best || hits > best.hits)) best = { cuisine, hits };
    }
    if (best) tags.add(best.cuisine);
  }

  for (const h of hints) {
    const t = titleCase(String(h).trim());
    if (t && t.length <= 30) tags.add(t);
  }

  // Vegetarian if we know enough about the dish and nothing meaty showed up.
  const hasMeat = MEAT_TAGS.some((t) => tags.has(t));
  if (hasMeat) { tags.delete('Vegetarian'); tags.delete('Vegan'); }
  else if (lines.length >= 3 && !/\b(gelatin|stock|broth|bouillon|fish sauce|oyster sauce|lard|anchov)/.test(text)) {
    tags.add('Vegetarian');
  }

  const order = (t) => (CUISINES.has(t) ? 0 : MEAT_TAGS.includes(t) ? 1 : 2);
  return [...tags].sort((a, b) => order(a) - order(b)).slice(0, 10);
}

export function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s\-&/(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

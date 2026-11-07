// English / Hindi switch for the survey form and the places around it (tabs, settings, status).
// Keys are the English texts themselves: anything without a Hindi entry simply stays English.
const KEY = 'ls.lang';

export const getLang = () => { try { return localStorage.getItem(KEY) === 'hi' ? 'hi' : 'en'; } catch { return 'en'; } };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Translate a text; `{name}` placeholders are filled from `vars`. */
export function t(en, vars) {
  let s = (getLang() === 'hi' && HI[en]) || en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

/** A span that stays translatable in place (see applyLang). */
export const L = (en) => `<span data-i18n="${esc(en)}">${esc(t(en))}</span>`;
/** placeholder attribute pair */
export const ph = (en) => `placeholder="${esc(t(en))}" data-i18n-ph="${esc(en)}"`;

/** Re-translate every marked element under `root` without rebuilding it (so nothing the user typed is lost). */
export function applyLang(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.documentElement.lang = getLang();
}

export function setLang(l) {
  try { localStorage.setItem(KEY, l === 'hi' ? 'hi' : 'en'); } catch {}
  applyLang();
  window.dispatchEvent(new Event('langchange'));
}

const HI = {
  // tabs & header
  'Survey': 'सर्वे', 'Dashboard': 'डैशबोर्ड', 'Report': 'रिपोर्ट',
  'Synced': 'सिंक हो गया', 'Uploading…': 'अपलोड हो रहा है…', 'Offline': 'ऑफ़लाइन', 'Demo mode': 'डेमो मोड',
  '{n} pending': '{n} लंबित', 'Offline · {n} pending': 'ऑफ़लाइन · {n} लंबित',
  // step 1
  'Line details': 'लाइन विवरण', 'Which line are you surveying?': 'आप किस लाइन का सर्वे कर रहे हैं?',
  '11 kV line': '11 kV लाइन', '33 kV line': '33 kV लाइन',
  'Subdivision': 'उपखंड', 'Substation': 'उपकेंद्र', 'Feeder': 'फीडर', 'Primary Substation': 'प्राथमिक उपकेंद्र',
  '33 kV Line': '33 kV लाइन', 'Section': 'सेक्शन', '(filled automatically)': '(अपने आप भरेगा)',
  'Select subdivision': 'उपखंड चुनें', 'Select substation': 'उपकेंद्र चुनें', 'Select feeder': 'फीडर चुनें',
  'Select primary substation': 'प्राथमिक उपकेंद्र चुनें', 'Select 33 kV line': '33 kV लाइन चुनें', 'Select section': 'सेक्शन चुनें',
  'Select a substation': 'पहले उपकेंद्र चुनें',
  'Line details are locked while a survey stretch is open. End the stretch (step 2) to survey another line.':
    'सर्वे खंड खुला रहने तक लाइन विवरण बदला नहीं जा सकता। दूसरी लाइन का सर्वे करने के लिए पहले खंड समाप्त करें (चरण 2)।',
  // step 2: stretch
  'Survey stretch': 'सर्वे खंड',
  'Where does this stretch of line begin? Type the starting point. GPS is captured automatically when you tap the button.':
    'लाइन का यह खंड कहाँ से शुरू हो रहा है? शुरुआती बिंदु लिखें। बटन दबाते ही GPS अपने आप दर्ज हो जाएगा।',
  'Start point': 'शुरुआती बिंदु', 'End point': 'अंतिम बिंदु',
  'Pole no. / village / landmark where the survey starts': 'पोल नं. / गाँव / लैंडमार्क जहाँ से सर्वे शुरू हो रहा है',
  'Pole no. / village / landmark where the survey ends': 'पोल नं. / गाँव / लैंडमार्क जहाँ सर्वे समाप्त हो रहा है',
  'Start survey from here': 'यहाँ से सर्वे शुरू करें', 'End survey here': 'यहाँ सर्वे समाप्त करें',
  'in progress': 'जारी है',
  '{n} survey recorded in this stretch': 'इस खंड में {n} सर्वे दर्ज', '{n} surveys recorded in this stretch': 'इस खंड में {n} सर्वे दर्ज',
  'Record the irregularities below as you walk the line. When you reach the end, enter the end point. You can do this after the survey, even later.':
    'लाइन पर चलते हुए नीचे अनियमितताएँ दर्ज करें। अंत में पहुँचकर अंतिम बिंदु भरें। यह सर्वे के बाद, बाद में भी किया जा सकता है।',
  '(fill after finishing the survey)': '(सर्वे पूरा होने के बाद भरें)',
  'Complete the Line details (step 1) first.': 'पहले लाइन विवरण भरें (चरण 1)।',
  'Open stretches': 'खुले सर्वे खंड',
  'Started on another phone? Tap Continue to carry on with it or to finish it.': 'किसी दूसरे फ़ोन पर शुरू किया था? उसे जारी रखने या पूरा करने के लिए "जारी रखें" दबाएँ।',
  'Continue': 'जारी रखें',
  'This stretch was ended on another phone': 'यह स्ट्रेच किसी दूसरे फ़ोन पर पूरा कर दिया गया है',
  'This stretch has been open for {h} hours. If the survey is finished, enter the end point.': 'यह खंड {h} घंटे से खुला है। सर्वे पूरा हो गया हो तो अंतिम बिंदु भरें।',
  // step 3
  'Irregularities found': 'पाई गई अनियमितताएँ',
  'Tick every problem seen at this pole / span. For line problems choose the voltage level.': 'इस पोल / स्पैन पर दिखी हर समस्या पर निशान लगाएँ। लाइन की समस्या के लिए वोल्टेज चुनें।',
  'Line:': 'लाइन:', 'Describe the irregularity': 'अनियमितता का वर्णन लिखें', '{n} selected': '{n} चुनी गईं',
  'Tilted Pole': 'झुका हुआ पोल', 'Dilapidated Pole': 'जर्जर पोल', 'Rusted Pole': 'जंग लगा पोल', 'Broken Pole': 'टूटा हुआ पोल',
  'Sagged Line': 'झूलती हुई लाइन', 'House/Construction Under Line': 'लाइन के नीचे मकान / निर्माण', 'Long Span Line': 'लंबा स्पैन',
  'Low Ground Clearance': 'कम ग्राउंड क्लीयरेंस', 'Road/Canal/River Crossing': 'सड़क / नहर / नदी क्रॉसिंग', 'GI Wire Line': 'जीआई तार वाली लाइन',
  'Too Many Joints In Span': 'स्पैन में बहुत अधिक जोड़', 'Damage AB Cable': 'क्षतिग्रस्त एबी केबल', 'Damage Pin Insulator': 'क्षतिग्रस्त पिन इंसुलेटर',
  'Damage Disc': 'क्षतिग्रस्त डिस्क इंसुलेटर', 'Other': 'अन्य',
  // step 4
  'Photographs': 'फोटो', 'Take photo': 'फोटो लें', 'Take another': 'एक और फोटो लें', 'Getting GPS…': 'GPS ले रहे हैं…',
  '{n} / min {min}': '{n} / कम से कम {min}',
  'Complete the Line details (step 1) before taking photographs.': 'फोटो लेने से पहले लाइन विवरण भरें (चरण 1)।',
  'Start the survey stretch (step 2) before taking photographs.': 'फोटो लेने से पहले सर्वे खंड शुरू करें (चरण 2)।',
  'GPS: starting…': 'GPS: शुरू हो रहा है…', 'GPS: acquiring location…': 'GPS: लोकेशन ले रहे हैं…',
  'GPS ±{acc} m · {lat}, {lng}': 'GPS ±{acc} मी · {lat}, {lng}',
  'GPS not supported on this device': 'इस डिवाइस में GPS उपलब्ध नहीं है',
  'Location permission denied — allow location for this site': 'लोकेशन की अनुमति नहीं मिली, इस साइट के लिए लोकेशन की अनुमति दें',
  'GPS: no signal, move to open sky': 'GPS: सिग्नल नहीं, खुले आसमान के नीचे जाएँ',
  // step 5, 6
  'Location & landmark': 'स्थान और लैंडमार्क', 'Location': 'स्थान', 'Landmark': 'लैंडमार्क', 'Remarks': 'टिप्पणी', '(optional)': '(वैकल्पिक)',
  'Village / mohalla / pole no. / span between poles': 'गाँव / मोहल्ला / पोल नं. / किन पोलों के बीच का स्पैन',
  'e.g. Near Shiv Mandir, opposite primary school': 'जैसे शिव मंदिर के पास, प्राथमिक विद्यालय के सामने',
  'Material required to rectify?': 'सुधार के लिए सामग्री चाहिए?', 'Yes': 'हाँ', 'No': 'नहीं',
  'Enter quantity against each item needed (poles & insulators in numbers, conductor & cable in metres).':
    'जो सामग्री चाहिए उसके सामने मात्रा भरें (पोल व इंसुलेटर संख्या में, कंडक्टर व केबल मीटर में)।',
  'Pole': 'पोल', 'Conductor': 'कंडक्टर', 'Pin Insulator': 'पिन इंसुलेटर', 'Disc Insulator': 'डिस्क इंसुलेटर',
  'V Cross Arm': 'वी क्रॉस आर्म', 'LT AB Cable': 'एलटी एबी केबल', 'metre': 'मीटर', 'nos': 'संख्या',
  'Clear': 'साफ़ करें', 'Submit survey': 'सर्वे जमा करें',
  // messages
  'Enter the starting point': 'शुरुआती बिंदु लिखें', 'Enter the end point': 'अंतिम बिंदु लिखें',
  'Survey started. Start point saved with GPS': 'सर्वे शुरू हुआ। शुरुआती बिंदु GPS सहित सहेजा गया',
  'Survey stretch completed. End point saved with GPS': 'सर्वे खंड पूरा हुआ। अंतिम बिंदु GPS सहित सहेजा गया',
  'Submit or clear the survey you are filling in before ending the stretch': 'खंड समाप्त करने से पहले भरे जा रहे सर्वे को जमा करें या साफ़ करें',
  'No irregularity has been recorded in this stretch. End it anyway?': 'इस खंड में कोई अनियमितता दर्ज नहीं हुई। फिर भी समाप्त करें?',
  'Complete the Line details (step 1) first': 'पहले लाइन विवरण भरें (चरण 1)', 'Start the survey stretch (step 2) first': 'पहले सर्वे खंड शुरू करें (चरण 2)',
  'Maximum {n} photographs': 'अधिकतम {n} फोटो', 'Survey saved — uploading…': 'सर्वे सहेजा गया, अपलोड हो रहा है…',
  'Saved offline — will upload when online': 'ऑफ़लाइन सहेजा गया, इंटरनेट आने पर अपलोड होगा',
  'Clear this survey? Photos and entries will be lost.': 'यह सर्वे साफ़ करें? फोटो और भरी हुई जानकारी मिट जाएगी।',
  'Could not load the line of this stretch': 'इस खंड की लाइन लोड नहीं हो सकी',
  'Please fix before submitting:': 'जमा करने से पहले सुधारें:',
  'Choose the line you are surveying: 11 kV or 33 kV': 'जिस लाइन का सर्वे कर रहे हैं उसे चुनें: 11 kV या 33 kV',
  'Start the survey stretch (step 2): enter the starting point first': 'सर्वे खंड शुरू करें (चरण 2): पहले शुरुआती बिंदु भरें',
  'Select at least one irregularity': 'कम से कम एक अनियमितता चुनें', 'Location is required': 'स्थान आवश्यक है', 'Landmark is required': 'लैंडमार्क आवश्यक है',
  'Take at least 2 photographs': 'कम से कम 2 फोटो लें', 'Choose whether material is required (Yes / No)': 'चुनें कि सामग्री चाहिए या नहीं (हाँ / नहीं)',
  'Enter quantity for at least one material': 'कम से कम एक सामग्री की मात्रा भरें', 'Describe the "Other" irregularity': '"अन्य" अनियमितता का वर्णन लिखें',
  'Surveyor name missing (open Settings)': 'सर्वेयर का नाम नहीं है (सेटिंग खोलें)',
  '{n} survey saved on this phone, waiting to upload.': '{n} सर्वे इस फ़ोन में सहेजा है, अपलोड होना बाकी है।',
  '{n} surveys saved on this phone, waiting to upload.': '{n} सर्वे इस फ़ोन में सहेजे हैं, अपलोड होना बाकी है।',
  'Upload now': 'अभी अपलोड करें', 'Discard': 'हटाएँ', 'Rejected by server: {e}': 'सर्वर ने अस्वीकार किया: {e}',
  'Discard this survey permanently?': 'यह सर्वे हमेशा के लिए हटा दें?',
  // warnings
  'An open stretch is already running on this line: {info}.\n\nStart another one anyway?': 'इस लाइन पर पहले से एक खंड खुला है: {info}।\n\nफिर भी नया शुरू करें?',
  'The end point is {km} km from the start point. Is that right?': 'अंतिम बिंदु शुरुआती बिंदु से {km} किमी दूर है। क्या यह सही है?',
  'This survey location is {km} km from the stretch start point. Submit anyway?': 'यह सर्वे स्थान खंड के शुरुआती बिंदु से {km} किमी दूर है। फिर भी जमा करें?',
  'Possible duplicate: a survey with the same problem was already recorded within {m} m of here:\n\n{list}\n\nSubmit anyway?':
    'संभावित दोहराव: यहाँ से {m} मीटर के भीतर इसी समस्या का सर्वे पहले ही दर्ज है:\n\n{list}\n\nफिर भी जमा करें?',
  // settings
  'Welcome — enter your name': 'स्वागत है, अपना नाम लिखें', 'Settings': 'सेटिंग', 'Surveyor name': 'सर्वेयर का नाम',
  'Admin key': 'एडमिन की', 'Test connection': 'कनेक्शन जाँचें', 'Save': 'सहेजें',
};

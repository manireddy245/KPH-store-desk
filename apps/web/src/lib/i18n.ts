import { useSession } from './session';

/**
 * English / Telugu screens, per person (their choice is saved with their user).
 * Words not in the list stay in English, so nothing ever shows blank.
 */
const TE: Record<string, string> = {
  // menu
  Billing: 'బిల్లింగ్',
  Dashboard: 'డాష్‌బోర్డ్',
  Owner: 'యజమాని',
  Assistant: 'సహాయకుడు',
  Sales: 'అమ్మకాలు',
  Operations: 'రోజువారీ పనులు',
  Purchases: 'కొనుగోళ్లు',
  Stock: 'సరుకు',
  Inventory: 'సరుకుల జాబితా',
  Customers: 'కస్టమర్లు',
  Khata: 'ఖాతా బాకీలు',
  Partners: 'భాగస్వాములు',
  Suppliers: 'సరఫరాదారులు',
  Accounts: 'ఖాతాలు',
  Reports: 'నివేదికలు',
  Activity: 'కార్యకలాపాలు',
  Settings: 'సెట్టింగ్స్',
  More: 'మరిన్ని',
  Menu: 'మెనూ',
  Lock: 'లాక్',
  Language: 'భాష',
  // billing
  Customer: 'కస్టమర్',
  Payment: 'చెల్లింపు',
  Cash: 'నగదు',
  UPI: 'UPI',
  Card: 'కార్డ్',
  Credit: 'అప్పు',
  'Save & print': 'సేవ్ & ప్రింట్',
  'Save only': 'సేవ్ మాత్రమే',
  'Clear bill': 'బిల్లు తీసివేయి',
  Total: 'మొత్తం',
  Gross: 'మొత్తం (తగ్గింపు ముందు)',
  Discount: 'తగ్గింపు',
  'Taxable value': 'పన్ను విధించే విలువ',
  'Round off': 'రౌండ్ ఆఫ్',
  'Balance due': 'బాకీ',
  'Credit limit': 'అప్పు పరిమితి',
  '+ New customer': '+ కొత్త కస్టమర్',
  'Place of supply': 'సరఫరా స్థలం',
  'Note on bill (optional)': 'బిల్లుపై గమనిక',
  'Brought by (painter, mason…)': 'తీసుకొచ్చినవారు (పెయింటర్, మేస్త్రీ…)',
  'Type product name, SKU or brand…': 'సరుకు పేరు లేదా బ్రాండ్ టైప్ చేయండి…',
  // common
  Save: 'సేవ్',
  Cancel: 'రద్దు',
  Print: 'ప్రింట్',
  Search: 'వెతుకు',
  Today: 'ఈ రోజు',
  'Receive payment': 'చెల్లింపు తీసుకోండి',
  'Print statement': 'ఖాతా వివరాలు ప్రింట్',
};

export function useT() {
  const { user } = useSession();
  const te = user?.language === 'te';
  return (s: string) => (te ? (TE[s] ?? s) : s);
}

export function useLang(): 'en' | 'te' {
  const { user } = useSession();
  return user?.language === 'te' ? 'te' : 'en';
}

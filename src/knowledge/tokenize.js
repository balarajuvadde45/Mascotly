// Tokenization + stopwords for BM25 / TF-IDF.
const STOPWORDS = new Set((
  'a,an,the,and,or,but,if,then,else,when,while,of,to,in,on,for,with,at,by,from,up,about,into,over,after,' +
  'is,are,was,were,be,been,being,am,do,does,did,doing,have,has,had,having,i,me,my,we,our,you,your,he,she,it,' +
  'they,them,their,this,that,these,those,there,here,what,which,who,whom,how,why,where,can,could,should,would,' +
  'will,shall,may,might,must,not,no,nor,so,too,very,just,also,than,as,its'
).split(','));

export function tokenize(text) {
  const out = [];
  const normalized = String(text ?? '').toLowerCase().normalize('NFKD');
  const re = /[a-z0-9][a-z0-9+#._-]*/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    let tok = m[0].replace(/[._-]+$/, '');
    if (tok.length < 1 || tok.length > 40) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

export { STOPWORDS };

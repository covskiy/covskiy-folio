import type { KnowledgeItem } from "./knowledge.js";

/**
 * Одно попадание ранжирования: запись справки и её score.
 */
export interface SearchHit {
  item: KnowledgeItem;
  /** IDF-взвешенная доля слов вопроса, найденных в записи: от 0 (не бывает — не попадает) до 1. */
  score: number;
}

// Служебные слова без поисковой ценности: вырезаются и из вопроса, и из записей
// (title/text/keywords), чтобы «как …?» не тянул совпадение из случайного «как»
// в тексте, а стоп-синоним в keywords не работал втихую. Одно-двухбуквенные
// предлоги/местоимения отсеял бы и лимит длины — в списке они для
// самодокументации: если лимит однажды снизят, эти слова не полезут в индекс
// молча. Себе/себя сознательно НЕ стоп-слова: синоним «о себе» иначе работал
// бы втихую (запись about находит вопрос через него).
const STOP_WORDS = new Set([
  // вопросительные и указательные
  "как",
  "что",
  "какой",
  "какая",
  "какие",
  "почему",
  "зачем",
  "когда",
  "где",
  "сколько",
  "это",
  "этот",
  "эта",
  "эти",
  "так",
  "там",
  "тут",
  "вот",
  // глаголы-обращения и вежливость
  "расскажи",
  "расскажите",
  "подскажи",
  "подскажите",
  "скажи",
  "скажите",
  "плиз",
  "пожалуйста",
  "спасибо",
  "привет",
  "здравствуйте",
  // предлоги и местоимения
  "для",
  "или",
  "про",
  "мне",
  "надо",
  "можно",
  "есть",
  "хочу",
  "не",
  "на",
  "по",
  "из",
  "от",
  "до",
  "вы",
  "мы",
  "ты",
  "тобой",
  "он",
  "она",
  "оно",
  "они",
  "тебе",
  "тебя",
  "вам",
  "вас",
  "нам",
  "нас",
  "них",
  "ей",
  "ему",
  "им",
  "мой",
  "моя",
  "мои",
  "твой",
  "твоя",
  "твои",
  "свой",
  "своя",
  "свои",
  "наш",
  "наша",
  "наши",
  "ваш",
  "ваша",
  "ваши",
  "уже",
  "еще",
  "тоже",
]);

// Короткие технические термины, за которыми стоит смысл: без allowlist их
// съедает общий минимум длины. Сам минимум не снижается — иначе в индекс
// полезет шум из предлогов и частиц.
const SHORT_TECH_WORDS = new Set(["it", "ux", "ui", "ai", "ии", "js", "ts"]);

// Минимум длины слова, попадающего в индекс; два символа осмысленны только
// для allowlist-терминов выше.
const MIN_WORD_LENGTH = 3;

// Слова — непрерывные последовательности букв и цифр (\p{L}\p{N}, флаг u):
// дефис, пунктуация и эмодзи — разделители, «PWA-приложения» → pwa + приложения.
const WORD_RE = /[\p{L}\p{N}]+/gu;

// Частые русские окончания — от длинных к коротким: срезается одно, первое
// совпавшее. Стемминг эвристический, без словарей: точность добирается
// префиксным сравнением основ (ниже) и keywords, а не новыми правилами.
const ENDINGS = [
  // трёхсимвольные
  "ами",
  "ями",
  "ого",
  "его",
  "ыми",
  "ими",
  // двухсимвольные
  "ах",
  "ях",
  "ам",
  "ям",
  "ов",
  "ев",
  "ой",
  "ый",
  "ий",
  "ая",
  "яя",
  "ое",
  "ее",
  "ые",
  "ие",
  "ую",
  "юю",
  "ом",
  "ем",
  // односимвольные
  "ы",
  "и",
  "а",
  "я",
  "о",
  "е",
  "у",
  "ю",
  "ь",
];

// Длина основы, с которой работает префиксное сравнение: «стоит» ↔ «стоимость»
// по «стои». Короче — только точное равенство основ, иначе короткие бытовые
// слова (код/год/лот) слипались бы в один класс по двум общим буквам.
const PREFIX_LENGTH = 4;

// Веса полей записи при индексации: заголовок и курируемые синонимы — полный
// вес, текст — половина (совпадение со случайным словом текста менее значимо).
const WEIGHT_TITLE = 1;
const WEIGHT_KEYWORDS = 1;
const WEIGHT_TEXT = 0.5;

/**
 * Индекс записи: основа → максимальный вес поля, где она встретилась.
 */
interface RecordIndex {
  weights: Map<string, number>;
}

/**
 * Индекс справки целиком: индексы записей (параллельны entries — порядок
 * файла) и document frequency по двум классам. Классы согласованы с правилом
 * совпадения в termWeight(): короткая основа (длина < 4) матчится только на
 * равенство, длинная — по префиксу. Вопрос и записи стеммятся одним
 * стеммером, поэтому «кодом» на обеих сторонах даёт основу «код» и попадает
 * в один и тот же класс df.
 */
interface CorpusIndex {
  records: RecordIndex[];
  /** df по точной основе: в скольких записях основа встретилась. */
  dfExact: Map<string, number>;
  /** df по классу префикса (первые 4 символа): для основ длиной ≥ 4. */
  dfPrefix: Map<string, number>;
}

// ё → е до разбиения: «чёрных» и «черных» — одно слово на обеих сторонах.
function words(text: string): string[] {
  return text.toLowerCase().replaceAll("ё", "е").match(WORD_RE) ?? [];
}

// Один фильтр для вопроса и для записей: стоп-слова и короткий шум вырезаются
// с обеих сторон, короткие технические термины проходят по allowlist.
function searchableWord(word: string): boolean {
  if (STOP_WORDS.has(word)) return false;
  return word.length >= MIN_WORD_LENGTH || SHORT_TECH_WORDS.has(word);
}

function stem(word: string): string {
  for (const ending of ENDINGS) {
    // Строгое неравенство: срез не должен съесть слово целиком («его» → «»).
    if (word.length > ending.length && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

function buildRecordIndex(item: KnowledgeItem): RecordIndex {
  const weights = new Map<string, number>();
  function addField(field: string, weight: number): void {
    for (const word of words(field)) {
      if (!searchableWord(word)) continue;
      const term = stem(word);
      const previous = weights.get(term);
      // Максимальный вес поля, не сумма: термин из нескольких полей берёт
      // вес сильнейшего поля — длинные записи не выигрывают объёмом.
      if (previous === undefined || weight > previous) weights.set(term, weight);
    }
  }
  addField(item.title, WEIGHT_TITLE);
  // keywords приходят из рукописного JSON: контракт поля даёт knowledge.ts,
  // но поисковый слой не должен знать деталей его валидации — используется
  // только массив непустых строк, что-то иное игнорируется целиком.
  const keywords = item.keywords;
  if (Array.isArray(keywords) && keywords.every((k) => typeof k === "string" && k.trim() !== "")) {
    for (const keyword of keywords) addField(keyword, WEIGHT_KEYWORDS);
  }
  addField(item.text, WEIGHT_TEXT);
  return { weights };
}

function buildCorpusIndex(entries: readonly KnowledgeItem[]): CorpusIndex {
  const records: RecordIndex[] = [];
  const dfExact = new Map<string, number>();
  const dfPrefix = new Map<string, number>();
  for (const item of entries) {
    const record = buildRecordIndex(item);
    records.push(record);
    // df — в скольких записях встречается: запись даёт вклад один раз,
    // сколько бы основ одного префиксного класса в ней ни было
    // («стоимость» и «стоит» в одной записи — всё ещё одна запись).
    const prefixes = new Set<string>();
    for (const term of record.weights.keys()) {
      dfExact.set(term, (dfExact.get(term) ?? 0) + 1);
      if (term.length >= PREFIX_LENGTH) prefixes.add(term.slice(0, PREFIX_LENGTH));
    }
    for (const prefix of prefixes) {
      dfPrefix.set(prefix, (dfPrefix.get(prefix) ?? 0) + 1);
    }
  }
  return { records, dfExact, dfPrefix };
}

// Кэш индекса по ИДЕНТИЧНОСТИ массива записей: knowledge.load() возвращает
// один и тот же массив на жизнь инстанса, поэтому токенизация и df считаются
// один раз, а не на каждый fallback. WeakMap вместо кэша-строки сознательно —
// по образцу promptCache в prompt.ts: вернувшаяся справка — это НОВЫЙ массив,
// деградированное состояние не может «застыть» в кэше.
const indexCache = new WeakMap<readonly KnowledgeItem[], CorpusIndex>();

function corpusIndex(entries: readonly KnowledgeItem[]): CorpusIndex {
  let index = indexCache.get(entries);
  if (index === undefined) {
    index = buildCorpusIndex(entries);
    indexCache.set(entries, index);
  }
  return index;
}

function idf(index: CorpusIndex, term: string): number {
  const total = index.records.length;
  const df =
    term.length >= PREFIX_LENGTH
      ? (index.dfPrefix.get(term.slice(0, PREFIX_LENGTH)) ?? 0)
      : (index.dfExact.get(term) ?? 0);
  return Math.log(1 + total / Math.max(df, 1));
}

/**
 * Вес термина вопроса в записи: максимальный вес поля среди основ записи,
 * совпавших с термином. Совпадение — основы равны ИЛИ первые 4 символа равны
 * при длине обеих ≥ 4: «стоит» ↔ «стоимость», «цены» ↔ «цена» по основе.
 * Совпадений нет → undefined.
 */
function termWeight(record: RecordIndex, term: string): number | undefined {
  if (term.length < PREFIX_LENGTH) {
    // Короткая основа совпадает только на равенство: префиксное сравнение
    // требует длину ≥ 4 с обеих сторон.
    return record.weights.get(term);
  }
  const prefix = term.slice(0, PREFIX_LENGTH);
  let best: number | undefined;
  for (const [stem, weight] of record.weights) {
    // Короткие основы индекса исключены: правило префикса требует длину ≥ 4
    // с обеих сторон, а точное равенство длинной и короткой основ невозможно.
    if (stem.length >= PREFIX_LENGTH && stem.startsWith(prefix)) {
      best = best === undefined ? weight : Math.max(best, weight);
    }
  }
  return best;
}

/**
 * Ранжирует записи справки под вопрос: score — IDF-взвешенная доля слов
 * вопроса, найденных в записи (title и keywords полным весом, text —
 * половиной; редкие слова весят больше частых). Возвращает все ненулевые
 * попадания по убыванию score; пусто — ни одно слово не совпало (пустой/
 * пунктуационный вопрос, пустая справка).
 *
 * Нормализация: lowercase, ё → е, разбиение по буквам и цифрам (дефис —
 * разделитель), стоп-слова и короткий шум вырезаются из вопроса И из записей,
 * короткие технические термины (IT, UX, …) проходят по allowlist, частые
 * русские окончания срезаются лёгким стеммером.
 *
 * Порог уверенности здесь НЕ применяется: это политика ответа brain.ts,
 * а не алгоритм ранжирования — попадания ниже порога могут пригодиться
 * подсказкам «возможно, ты искал это».
 *
 * Модуль доменной логики: не читает файлы, не ходит в сеть, не логирует,
 * не бросает; детерминирован — равные score и равное число сильных совпадений
 * сохраняют порядок входного массива (порядок файла). Индекс и df кэшируются
 * по идентичности массива записей (WeakMap).
 *
 * @param {string} question - Вопрос пользователя.
 * @param {readonly KnowledgeItem[]} entries - Валидированные записи справки
 *   (принимает готовыми из knowledge.ts, сам не читает knowledge.json).
 * @returns {SearchHit[]} Попадания score > 0 по убыванию score.
 */
export function rankKnowledge(question: string, entries: readonly KnowledgeItem[]): SearchHit[] {
  const index = corpusIndex(entries);

  // Слова вопроса: тот же фильтр, что для записей; основы дедуплицируются —
  // повтор слова не должен двоить вклад (Set сохраняет порядок появления).
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const word of words(question)) {
    if (!searchableWord(word)) continue;
    const term = stem(word);
    if (!seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  if (terms.length === 0) return [];

  // Знаменатель — по ВСЕМ словам вопроса, включая не совпавшие ни с одной
  // записью: незнакомые слова снижают score, а не игнорируются.
  const idfByTerm = new Map<string, number>();
  let denominator = 0;
  for (const term of terms) {
    const weight = idf(index, term);
    idfByTerm.set(term, weight);
    denominator += weight;
  }

  // strong — число сильных совпадений (title/keywords): первый tie-break
  // после score, второй — порядок файла (стабильный sort).
  const scored: Array<{ item: KnowledgeItem; score: number; strong: number }> = [];
  index.records.forEach((record, i) => {
    let numerator = 0;
    let strong = 0;
    for (const term of terms) {
      const fieldWeight = termWeight(record, term);
      if (fieldWeight === undefined) continue;
      numerator += (idfByTerm.get(term) ?? 0) * fieldWeight;
      if (fieldWeight >= WEIGHT_TITLE) strong += 1;
    }
    if (numerator > 0) {
      scored.push({ item: entries[i], score: numerator / denominator, strong });
    }
  });

  // sort в JS стабилен (ES2019): равные score и strong остаются в порядке
  // файла.
  return scored
    .sort((a, b) => b.score - a.score || b.strong - a.strong)
    .map(({ item, score }) => ({ item, score }));
}

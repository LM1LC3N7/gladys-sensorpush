// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why the account or a sensor has no fresh value. */
export const REASONS = {
  refused: { en: 'e-mail or password refused', fr: 'e-mail ou mot de passe refusé' },
  expired: {
    en: 'data refused even with a new sign-in',
    fr: 'données refusées même après une nouvelle connexion',
  },
  limited: { en: 'too many requests (pause)', fr: 'trop de requêtes (pause)' },
  busy: { en: 'service unavailable (pause)', fr: 'service indisponible (pause)' },
  failed: { en: 'no answer', fr: 'pas de réponse' },
  invalid: { en: 'not a SensorPush answer', fr: "réponse qui n'est pas celle de SensorPush" },
  stale: { en: 'no recent reading', fr: 'pas de mesure récente' },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

export const T = {
  notConfigured: {
    en: 'Enter the e-mail address and the password of your SensorPush account.',
    fr: "Saisissez l'adresse e-mail et le mot de passe de votre compte SensorPush.",
  },
  oneMissing: {
    en: 'Both are needed: the e-mail address and the password.',
    fr: "Les deux sont nécessaires : l'adresse e-mail et le mot de passe.",
  },
  invalid: {
    en: 'E-mail or password not valid: it holds a line break or a control character, or the address has no "@". Type it again.',
    fr: "E-mail ou mot de passe non valide : il contient un retour à la ligne ou un caractère de contrôle, ou l'adresse n'a pas de « @ ». Saisissez-le à nouveau.",
  },
  refusedHelp: {
    en: 'SensorPush refused the e-mail or the password: no new sign-in until you change them (or press the test button). Check them on dashboard.sensorpush.com, where the API access of the account must be activated once.',
    fr: "SensorPush a refusé l'e-mail ou le mot de passe : plus aucune connexion tant que vous ne les changez pas (ou que vous n'appuyez pas sur le bouton de test). Vérifiez-les sur dashboard.sensorpush.com, où l'accès à l'API du compte doit avoir été activé une fois.",
  },
  moreSensors: (n, max) => ({
    en: `${n} more sensor(s) of the account not read (at most ${max}).`,
    fr: `${n} autre(s) capteur(s) du compte non lu(s) (${max} au plus).`,
  }),
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  /** The connected status: what is read, how often, and what fails. */
  ok: ({ sensors, interval, failing = [] }) => {
    let en = `${sensors} SensorPush sensor(s), read every ${interval} min.`;
    let fr = `${sensors} capteur(s) SensorPush, lu(s) toutes les ${interval} min.`;
    if (failing.length > 0) {
      en += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      fr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return { en, fr };
  },
};

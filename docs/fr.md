# SensorPush

**Connecteur non officiel, sans lien avec SensorPush.** Il amène dans Gladys
les capteurs **SensorPush** de votre compte (HT1, HT.w, HTP.xw...), lus par
l'**API officielle SensorPush Gateway Cloud**.

> **Cette intégration n'a jamais été testée avec un vrai capteur.** Elle suit
> la description officielle de l'API et les bibliothèques de l'intégration
> SensorPush Cloud de Home Assistant. Merci de signaler ce que vous constatez
> sur le forum de Gladys.

## Ce qu'il faut

- Une **passerelle Wi-Fi SensorPush G1** : elle relaie les capteurs vers le
  cloud SensorPush. Les capteurs eux-mêmes parlent Bluetooth, que cette
  intégration n'utilise pas (une intégration Gladys tourne dans un conteneur
  sans Bluetooth).
- L'**accès à l'API** de votre compte activé : connectez-vous une fois sur
  [dashboard.sensorpush.com](https://dashboard.sensorpush.com) avec l'e-mail
  et le mot de passe de l'application SensorPush, et acceptez les conditions
  de l'API si elles sont demandées.

## Ce que vous obtenez

Un appareil Gladys par capteur, nommé comme dans l'application SensorPush :

| Fonction                      | Unité | Remarques                                                 |
| ----------------------------- | ----- | --------------------------------------------------------- |
| Température                   | °C    | la température de la pièce dans Gladys                    |
| Humidité                      | %     |                                                           |
| Pression                      | hPa   | HTP.xw seulement                                          |
| Point de rosée                | °C    | une sonde : hors de la moyenne de température de la pièce |
| Déficit de pression de vapeur | kPa   | utile pour une serre ou une culture                       |
| Tension de la pile (V)        | V     | environ 3 V neuve ; à remplacer sous environ 2,6 V        |
| Signal (dB)                   | dB    | le signal Bluetooth entre le capteur et sa passerelle     |

- Seul ce que votre capteur mesure est créé (un HT1 n'a pas de pression).
- SensorPush envoie des °F et des inHg : convertis en °C et en hPa par
  l'intégration, les unités que Gladys liste pour chaque sorte de capteur.
  Gladys n'a pas d'unité pour une tension ni pour un signal en dB : ces deux
  valeurs sont de simples nombres, l'unité dans leur nom.
- Les noms des fonctions sont en anglais ; renommez-les à la création si vous
  le souhaitez.

## Installation

1. Installez l'intégration depuis le catalogue de Gladys (Gladys 5.1 ou
   plus récent).
2. Dans l'écran **Configuration**, saisissez l'**adresse e-mail** et le
   **mot de passe** de votre compte SensorPush.
3. Cliquez sur **Tester SensorPush** : le message affiche les principales
   valeurs de chaque capteur.
4. Ouvrez l'onglet **Découverte** et ajoutez les appareils. Leurs valeurs
   arrivent dès leur création.

## Configuration

- **Adresse e-mail** et **mot de passe** : le mot de passe est gardé par
  Gladys dans sa base (en clair, comme tout champ secret de Gladys) et jamais
  réaffiché dans l'écran de configuration. Il est envoyé seulement à
  SensorPush (`api.sensorpush.com`), dans le corps de la requête de
  connexion, jamais dans une URL, un journal, un statut ni sous `/data`. Pas
  plus que l'adresse e-mail, ni le jeton d'accès que SensorPush renvoie
  (gardé en mémoire seulement).
- **Intervalle de lecture** : 5 minutes par défaut, de 1 à 60. SensorPush
  demande de ne pas lire plus d'une fois par minute ; la passerelle envoie
  ses mesures environ une fois par minute.

## À quel rythme SensorPush est lu

- À chaque intervalle, **une requête** demande la dernière mesure de tous
  les capteurs (`POST /samples`, une mesure chacun).
- La **liste des capteurs** (`POST /devices/sensors` : noms, pile, signal)
  est lue au démarrage, puis toutes les heures, et quand une mesure vient
  d'un capteur encore inconnu (au plus toutes les 30 minutes).
- Une **connexion** (`POST /oauth/authorize`, puis `POST /oauth/accesstoken`)
  donne un jeton d'accès valable une heure ; il sert 50 minutes au plus.
  Cette API n'a pas de jeton de renouvellement : un nouveau jeton demande à
  nouveau l'e-mail et le mot de passe. Si une requête refuse le jeton,
  l'intégration se reconnecte **une** fois et redemande ; refusé encore, elle
  attend l'intervalle suivant (jamais de boucle).
- **Jamais plus vite que l'intervalle**, compté depuis la dernière requête
  envoyée : ni par le bouton de test, ni par une reconnexion à Gladys, ni par
  une configuration enregistrée, ni par l'onglet Découverte, ni par un
  redémarrage du conteneur. Seuls d'autres identifiants sont essayés tout de
  suite. Avant la fin de l'intervalle, le bouton de test affiche les
  dernières valeurs et l'heure de la prochaine lecture possible.
- **Lecture seule** : l'intégration n'écrit jamais rien sur un capteur, une
  passerelle ni le compte.
- Quand SensorPush répond **429 ou une erreur 5xx**, il est laissé tranquille
  pendant le délai `Retry-After` donné, sinon 5 minutes, puis 10, 20... ;
  toujours entre 1 minute et 6 heures. Un 429 sur la connexion est aussi une
  pause, jamais un mot de passe refusé.
- Quand SensorPush **refuse l'e-mail ou le mot de passe**, les connexions
  s'arrêtent **définitivement** et le statut le dit : aucun nouvel essai de
  lui-même, même après un redémarrage, pour que le compte ne soit jamais
  bloqué par des essais répétés. Changez l'e-mail ou le mot de passe (il est
  alors essayé tout de suite), ou appuyez sur le bouton de test une fois
  l'intervalle écoulé (un essai). Vider un champ puis le saisir à nouveau, ou
  enregistrer la configuration, ne lève jamais le refus.
- Une adresse e-mail sans « @ », ou un e-mail ou un mot de passe contenant
  un retour à la ligne ou un caractère de contrôle (un mauvais copier-coller),
  est refusé tout de suite (« non valide ») et jamais envoyé.
- Une mesure de plus d'une heure (ou de deux intervalles) n'est pas publiée ;
  son âge est mesuré avec l'horloge de SensorPush (la `Date` de sa réponse),
  donc une horloge de Gladys décalée ne la fait jamais paraître plus vieille
  ni plus récente. Une mesure est remise à Gladys une seule fois : un capteur
  qui ne remonte plus ne paraît jamais vivant.
- Si la liste des capteurs échoue alors que des capteurs sont connus, leurs
  mesures sont quand même lues ; la liste est réessayée 30 minutes plus tard.
- L'heure de la dernière requête, la pause, le refus et les capteurs
  rencontrés (identifiant, nom, modèle, mesures : rien de secret, jamais
  l'adresse e-mail ni l'adresse MAC d'un capteur) survivent à une reconnexion
  et à un redémarrage du conteneur : ils sont gardés dans un fichier sous
  `/data`. L'heure d'une requête est écrite avant que la requête parte, au
  plus une fois par minute ; une pause, un refus ou un nouveau capteur est
  écrit tout de suite. Seulement tant que le mot de passe est refusé, le
  fichier garde une empreinte salée (scrypt) de l'e-mail et du mot de passe
  refusés, pour qu'après un redémarrage d'autres identifiants soient essayés
  tout de suite ; elle est effacée par la première connexion réussie, donc
  rien dans le fichier ne peut confirmer un mot de passe qui fonctionne.
- 50 capteurs au plus sont lus ; 250 valeurs au plus sont envoyées à Gladys
  par minute ; une réponse de plus de 1 Mo, ou de plus de 15 secondes, est
  abandonnée.

## Identifiants externes

`ext:sensorpush:sensor:<identifiant du capteur>`, l'identifiant étant celui
de l'API SensorPush en minuscules, chaque caractère non alphanumérique
remplacé par `-` (`16825929.17287013094063749210` donne
`16825929-17287013094063749210`), puis `:<fonction>` (`temperature`,
`humidity`, `pressure`, `dew_point`, `vpd`, `battery_voltage`, `signal`).
Ces identifiants ne changent jamais.

## Dépannage

- **« e-mail ou mot de passe refusé »** : vérifiez-les dans l'application
  SensorPush, et que l'accès à l'API est activé sur dashboard.sensorpush.com.
  Puis changez-les dans la configuration, ou appuyez sur le bouton de test.
- **« données refusées même après une nouvelle connexion »** : l'accès à
  l'API n'est peut-être pas activé pour le compte ; connectez-vous sur
  dashboard.sensorpush.com.
- **« pas de mesure récente »** : le capteur n'a pas été entendu par une
  passerelle depuis plus d'une heure (hors de portée, pile vide, passerelle
  hors ligne).
- Journaux : le niveau se règle avec la variable `LOG_LEVEL`.

## Vie privée

L'intégration ne parle qu'à `api.sensorpush.com`, en HTTPS, avec votre
adresse e-mail et votre mot de passe (connexion) puis le jeton d'accès. Des
réponses, elle ne garde que l'identifiant, le nom et le modèle de chaque
capteur et ses mesures.

## Crédits

Construite d'après [sstallion/sensorpush-api](https://github.com/sstallion/sensorpush-api)
(BSD 2-Clause, Steven Stallion), le client de l'API SensorPush généré depuis
sa description officielle, et
[sstallion/sensorpush-ha](https://github.com/sstallion/sensorpush-ha) (BSD
2-Clause, Steven Stallion), la bibliothèque de l'intégration SensorPush Cloud
de Home Assistant : les routes, la connexion, les champs et leurs unités sont
portés en JavaScript. Leurs notices sont dans `THIRD_PARTY_NOTICES.md`.
SensorPush est une marque de son propriétaire ; ce connecteur est gratuit et
non officiel.

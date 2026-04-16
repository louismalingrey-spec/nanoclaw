---
name: prospection
description: |
  Cold email drafting for agency outreach. Trigger: /prospecte
  Fetches Louis's real sent cold emails as style reference, then drafts
  2 angle variants in a single Gmail draft ready to send.
---

# Prospection — Cold Email Drafting

## Trigger

```
/prospecte [prénom] [email]
[bloc de recherche libre : ce que tu sais sur la personne, le produit, angle(s) envisagé(s)]
```

## Workflow

### Étape 1 — Vérifier gbrain

Si gbrain est disponible (`mcp__gbrain__*`), chercher le prospect :

```
mcp__gbrain__search({ query: "[prénom] [nom ou boîte]" })
```

Si une page existe, la lire pour enrichir le contexte. Si non, continuer.

### Étape 2 — Récupérer le corpus de style

Chercher dans Gmail les threads labellisés `cold-outreach-ref` :

```
mcp__gmail__search_threads({ query: "label:cold-outreach-ref" })
```

Pour chaque thread retourné, récupérer le thread et extraire **uniquement le premier message** (`messages[0]`). Ces messages sont les vrais cold emails envoyés — c'est le corpus de style.

Si le label n'existe pas ou renvoie 0 résultats, continuer avec le style décrit ci-dessous.

### Étape 3 — Analyser le style

À partir des emails de référence, extraire :

- **Pattern du hook** : observation hyper-spécifique sur le produit, une découverte, un article, un post, du potentiel viral détecté
- **Longueur** : 100–250 mots par email
- **Ton** : direct, pas de fluff, comme un message entre pairs — pas du corporate
- **Structure** : hook → gap/observation → ce qu'on fait → preuve sociale → CTA soft
- **Preuve sociale systématique** : Parrot (YC) → 90M vues/mois à ~$0.5 CPM, Cheateye → 52M vues/mois à ~$2 CPM
- **Signature** : "Best, Louis" (EN) ou "Louis" (FR)
- **Langue** : matcher la langue du prospect (EN par défaut, FR si clairement francophone)

### Étape 4 — Rédiger 2 propositions avec 2 angles différents

Utiliser le bloc de recherche fourni pour rédiger **2 emails distincts** avec des angles contrastés.

Chaque email doit :
- Commencer par une observation spécifique à cette personne (jamais générique)
- Faire 100–250 mots
- Inclure les case studies pertinents avec les vrais chiffres
- Finir par une question soft — jamais une proposition de meeting direct
- Respecter le style extrait à l'étape 3

**Angles possibles (choisir 2 qui contrastent) :**
- **Produit** : observation sur une feature, un mécanisme viral, un moment UGC-ready dans l'app
- **Timing** : référencer un lancement récent, une levée, une tendance qu'ils surfent
- **Concurrent** : comment une app similaire cartonne déjà avec ce playbook
- **Gap** : "je n'ai trouvé aucun creator content sur votre app..."
- **Histoire personnelle** : ex-fondateur, j'ai bossé dans leur espace, je comprends leur situation
- **Article/trigger externe** : article trouvé, post LinkedIn, tweet qui fait écho

### Étape 5 — Créer le brouillon Gmail

Créer un seul brouillon Gmail avec les 2 propositions dans le corps, séparées par `--` :

```
mcp__gmail__create_draft({
  to: "[email]",
  subject: "Quick question, [prénom]",
  body: "[proposition 1]\n\n--\n\n[proposition 2]"
})
```

Pour un prospect FR, subject : "Question rapide, [prénom]"

### Étape 6 — Confirmer

Répondre dans Slack : `Draft Gmail créé pour [prénom] ([email]) ✓`

Si gbrain est disponible et que le prospect n'avait pas de page, créer silencieusement une page `people/prospects/[slug]` avec les infos du bloc de recherche.

## Anti-patterns

- Jamais de hook générique ("I was impressed by your company...")
- Jamais proposer un meeting directement — toujours une question ouverte
- Jamais d'emojis
- Jamais dépasser 250 mots par proposition
- Ne pas utiliser le même angle pour les 2 propositions
- Ne pas annoncer ce qu'on fait étape par étape — exécuter et confirmer à la fin uniquement

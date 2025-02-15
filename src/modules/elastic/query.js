require('../env');
const taxons = require('../../taxons');

function buildQuery(query, target, relaxed) {
  const queryField = {
    text: 'text',
    introduction: 'zoneIntroduction',
    expose: 'zoneExpose',
    moyens: 'zoneMoyens',
    motivations: 'zoneMotivations',
    dispositif: 'zoneDispositif',
    annexes: 'zoneAnnexes',
    visa: 'visa', // Not affected by 'exact' match
    summary: 'summary',
    themes: 'themes',
  };
  let taxonFilter = 'cc';
  let searchQuery;
  let textFields = [];
  let boostedFields = [];
  let page = query.page || 0;
  let page_size = query.page_size || 10;
  let string = query.query ? query.query.trim() : '';
  let hasString = false;
  if (target === 'export') {
    // No search query when exporting data:
    string = '';
  }

  // Detect some special data in query string:
  let splitString = [];
  let searchVisa = false;
  let searchECLI = [];
  let searchPourvoiNumber = [];
  let searchString = [];
  let searchDate = null;
  if (string) {
    if (/article\D+\d/i.test(string)) {
      searchVisa = true;
    }
    if (/"[^"]+"/.test(string)) {
      query.operator = 'exact';
    }
    if (/\d\d\/\d\d\/\d\d\d\d/.test(string)) {
      let inputDate = /(\d\d)\/(\d\d)\/(\d\d\d\d)/.exec(string);
      searchDate = `${inputDate[3]}-${inputDate[2]}-${inputDate[1]}`;
      string = string.replace(`${inputDate[1]}/${inputDate[2]}/${inputDate[3]}`, '');
    }
    splitString = string.split(/[\s,;/?!]+/gm);
    for (let i = 0; i < splitString.length; i++) {
      if (/^ecli:\w+:\w+:\d+:[a-z0-9.]+$/i.test(splitString[i])) {
        searchECLI.push(splitString[i]);
      } else if (/\D?\d\d\D?\d\d\D?\d\d\d\D?/.test(splitString[i])) {
        searchPourvoiNumber.push(splitString[i].replace(/\D/gm, '').trim());
      } else if (splitString[i]) {
        searchString.push(splitString[i]);
      }
    }
  }

  if (relaxed) {
    query.operator = 'or';
  }

  if (target === 'search' || target === 'export') {
    if (target === 'export') {
      page = query.batch || 0;
      page_size = query.batch_size || 10;
    }

    // Base query for regular search:
    searchQuery = {
      index: process.env.ELASTIC_INDEX,
      preference: 'preventbouncingresults',
      explain: false,
      from: page * page_size,
      size: page_size,
      _source: true,
      body: {
        track_scores: true,
        query: {
          function_score: {
            query: {
              bool: {},
            },
            boost: 5,
            functions: [
              {
                filter: {
                  match: {
                    publication: 'b',
                  },
                },
                weight: 50,
              },
              {
                filter: {
                  match: {
                    publication: 'r',
                  },
                },
                weight: 10,
              },
              {
                filter: {
                  match: {
                    publication: 'c',
                  },
                },
                weight: 5,
              },
              {
                filter: {
                  match: {
                    publication: 'l',
                  },
                },
                weight: 2,
              },
              {
                filter: {
                  match: {
                    publication: 'n',
                  },
                },
                weight: 0.1,
              },
              {
                filter: {
                  match: {
                    lowInterest: true,
                  },
                },
                weight: 0.1,
              },
              {
                filter: {
                  match: {
                    jurisdiction: 'ca',
                  },
                },
                weight: 0.1,
              },
              {
                filter: {
                  match: {
                    jurisdiction: 'tj',
                  },
                },
                weight: 0.1,
              },
            ],
            score_mode: 'max',
            boost_mode: 'multiply',
          },
        },
        sort: [
          {
            _score: 'desc',
          },
          {
            decision_date: 'desc',
          },
        ],
        highlight: {
          fields: {},
        },
      },
    };

    // Sort and order:
    if (target === 'export') {
      // Cleanup base query:
      searchQuery.body.track_scores = false;
      delete searchQuery.body.query.function_score.boost;
      delete searchQuery.body.query.function_score.functions;
      delete searchQuery.body.query.function_score.score_mode;
      delete searchQuery.body.query.function_score.boost_mode;
      if (query.date_type === 'update') {
        searchQuery.body.sort[0] = {
          update_date: query.order || 'desc',
        };
      } else {
        searchQuery.body.sort[0] = {
          decision_date: query.order || 'desc',
        };
      }
      delete searchQuery.body.query.highlight;
    } else if (query.sort && query.order) {
      switch (query.sort) {
        case 'score':
          delete searchQuery.body.query.function_score.functions;
          searchQuery.body.sort[0]._score = query.order;
          break;
        case 'scorepub':
          searchQuery.body.sort[0]._score = query.order;
          break;
        case 'date':
          delete searchQuery.body.query.function_score.functions;
          searchQuery.body.sort.pop();
          searchQuery.body.sort[0] = {
            decision_date: query.order,
          };
          break;
      }
    }

    // ECLI (filter):
    if (searchECLI.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          ecli: searchECLI,
        },
      });
    }

    // "Pourvoi" number (filter):
    if (searchPourvoiNumber.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchPourvoiNumber.forEach((pourvoiNumber) => {
        searchQuery.body.query.function_score.query.bool.filter.push({
          wildcard: {
            number: {
              value: `*${pourvoiNumber}`,
            },
          },
        });
      });
    }

    // Publication (filter):
    if (query.publication && Array.isArray(query.publication) && query.publication.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          publication: query.publication,
        },
      });
    }

    // Formation (filter):
    if (query.formation && Array.isArray(query.formation) && query.formation.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          formation: query.formation,
        },
      });
    }

    // Chamber (filter):
    if (query.chamber && Array.isArray(query.chamber) && query.chamber.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      if (query.chamber.indexOf('allciv') !== -1) {
        const chamberTerms = ['civ1', 'civ2', 'civ3'];
        query.chamber.forEach((chamberItem) => {
          if (chamberItem.indexOf('civ') === -1) {
            chamberTerms.push(chamberItem);
          }
        });
        searchQuery.body.query.function_score.query.bool.filter.push({
          terms: {
            chamber: chamberTerms,
          },
        });
      } else {
        searchQuery.body.query.function_score.query.bool.filter.push({
          terms: {
            chamber: query.chamber,
          },
        });
      }
    }

    // Type (filter):
    if (query.type && Array.isArray(query.type) && query.type.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          type: query.type,
        },
      });
    }

    // Solution (filter):
    if (query.solution && Array.isArray(query.solution) && query.solution.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          solution: query.solution,
        },
      });
    }

    // Jurisdiction (filter):
    if (query.jurisdiction && Array.isArray(query.jurisdiction) && query.jurisdiction.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          jurisdiction: query.jurisdiction,
        },
      });
      if (query.jurisdiction.length === 1) {
        taxonFilter = query.jurisdiction[0];
      } else {
        taxonFilter = 'all';
      }
    } else {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          jurisdiction: ['cc'],
        },
      });
      taxonFilter = 'cc';
    }

    // Location (filter):
    if (query.location && Array.isArray(query.location) && query.location.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          location: query.location,
        },
      });
    }

    // Themes (filter):
    if (query.theme && Array.isArray(query.theme) && query.theme.length > 0) {
      if (taxonFilter === 'cc') {
        if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
          searchQuery.body.query.function_score.query.bool.filter = [];
        }
        searchQuery.body.query.function_score.query.bool.filter.push({
          terms: {
            themesFilter: query.theme.map((item) => {
              return `${item}`.toLowerCase();
            }),
          },
        });
      } else {
        hasString = false;
        let _themesFilter = [];
        query.theme.forEach((string) => {
          if (/^\w+$/i.test(string) === true) {
            if (!query.field || Array.isArray(query.field) === false) {
              query.field = [];
            }
            if (query.field.indexOf('themes') === -1) {
              query.field.push('themes');
            }
            searchString.push(string.split(/[\s,;/?!]+/gm).join(' '));
          } else {
            _themesFilter.push(string);
          }
          hasString = true;
        });
        if (_themesFilter.length > 0) {
          searchQuery.body.query.function_score.query.bool.filter.push({
            terms: {
              themesFilter: _themesFilter,
            },
          });
        }
      }
    }

    // withFileOfType (filter):
    if (query.withFileOfType && Array.isArray(query.withFileOfType) && query.withFileOfType.length > 0) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        terms: {
          fileType: query.withFileOfType,
        },
      });
    }

    // particularInterest (filter):
    if (query.particularInterest) {
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push({
        term: {
          particularInterest: true,
        },
      });
    }

    if (target === 'export') {
      const legacyFilter = [];

      Object.keys(query).forEach((key) => {
        if (/^legacy\.\w+$/i.test(key)) {
          legacyFilter.push({ key: key, value: query[key] });
        }
      });

      for (let l = 0; l < legacyFilter.length; l++) {
        if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
          searchQuery.body.query.function_score.query.bool.filter = [];
        }
        let terms = {};
        if (isNaN(parseInt(legacyFilter[l].value, 10))) {
          terms[legacyFilter[l].key] = [legacyFilter[l].value];
        } else {
          terms[legacyFilter[l].key] = [parseInt(legacyFilter[l].value, 10)];
        }
        searchQuery.body.query.function_score.query.bool.filter.push({
          terms: terms,
        });
      }
    }

    // Date start/end (filter):
    if (query.date_start || query.date_end) {
      let datetime = false;
      if (
        (query.date_start && /^\d\d\d\d-\d\d-\d\d$/.test(query.date_start) === false) ||
        (query.date_end && /^\d\d\d\d-\d\d-\d\d$/.test(query.date_end) === false)
      ) {
        datetime = true;
      }
      let date_field = datetime ? 'decision_datetime' : 'decision_date';

      if (target === 'export' && query.date_type) {
        date_field =
          query.date_type === 'creation'
            ? datetime
              ? 'decision_datetime'
              : 'decision_date'
            : datetime
            ? 'update_datetime'
            : 'update_date';
      }
      let range = {
        range: {},
      };
      range.range[date_field] = {};
      if (query.date_start) {
        range.range[date_field].gte = query.date_start;
      }
      if (query.date_end) {
        range.range[date_field].lte = query.date_end;
      }
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push(range);
    } else if (searchDate !== null) {
      let range = {
        range: {
          decision_date: {
            gte: searchDate,
            lte: searchDate,
          },
        },
      };
      if (searchQuery.body.query.function_score.query.bool.filter === undefined) {
        searchQuery.body.query.function_score.query.bool.filter = [];
      }
      searchQuery.body.query.function_score.query.bool.filter.push(range);
    }

    if (target !== 'export' && searchString.length > 0) {
      // Specific and default text fields to search in:
      if (query.field && Array.isArray(query.field) && query.field.length > 0) {
        query.field.forEach((field) => {
          if (queryField[field] && textFields.indexOf(queryField[field]) === -1) {
            textFields.push(queryField[field]);
          }
        });
      }

      // Add search on 'text' field if none is set:
      if (textFields.length === 0) {
        textFields.push('text');
      }

      if (searchVisa === true && textFields.indexOf('visa') === -1) {
        textFields.push('visa');
      }

      // Handle 'exact' match:
      if (query.operator && query.operator === 'exact') {
        textFields = textFields.map((item) => {
          if (item !== 'visa') {
            return item + '.exact';
          }
          return item;
        });
      }

      // Boosts text fields:
      boostedFields = textFields.map((item) => {
        if (item === 'visa' || item === 'summary' || item === 'themes') {
          return item + '^10';
        } else if (item === 'zoneMotivations' || item === 'zoneDispositif') {
          return item + '^6';
        } else if (item === 'zoneExpose' || item === 'zoneMoyens') {
          return item + '^3';
        } else if (item === 'zoneIntroduction' || item === 'zoneAnnexes') {
          return item + '^2';
        }
        return item;
      });

      // Highlight text fields:
      textFields.forEach((field) => {
        if (field !== 'themes') {
          searchQuery.body.highlight.fields[field] = {};
        }
      });
    }

    // Finalize search in  text fields:
    if (searchString.length > 0 && boostedFields.length > 0) {
      hasString = true;
      let operator = taxons[taxonFilter].operator.default.toUpperCase();
      let fuzzy = true;
      let finalSearchString = searchString.join(' ');
      if (query.operator) {
        if (query.operator === 'exact') {
          operator = 'AND';
          fuzzy = false;
          if (/^"/.test(string) === false || /"$/.test(string) === false) {
            finalSearchString = `"${string}"`.replace(/"+/gm, '"');
          }
        } else {
          operator = query.operator.toUpperCase();
        }
      }
      if (/[*()~|+-]/.test(string) && !relaxed) {
        operator = 'AND';
        fuzzy = false;
        finalSearchString = string;
      }
      searchQuery.body.query.function_score.query.bool.must = {
        simple_query_string: {
          query: finalSearchString,
          fields: boostedFields,
          default_operator: operator,
          auto_generate_synonyms_phrase_query: fuzzy,
          fuzzy_max_expansions: fuzzy ? 50 : 0,
          fuzzy_transpositions: fuzzy,
        },
      };
    }
  } else if (target === 'decision') {
    // Base query for single decision highlighting:
    searchQuery = {
      index: process.env.ELASTIC_INDEX,
      preference: 'preventbouncingresults',
      explain: false,
      from: 0,
      size: 1,
      _source: false,
      body: {
        query: {
          function_score: {
            query: {
              bool: {
                filter: [
                  {
                    ids: {
                      values: [query.id],
                    },
                  },
                ],
              },
            },
          },
        },
        highlight: {
          fields: {},
        },
      },
    };

    // Specific and default text fields to search in:
    if (query.field && Array.isArray(query.field) && query.field.length > 0) {
      query.field.forEach((field) => {
        if (field !== 'text' && queryField[field] && textFields.indexOf(queryField[field]) === -1) {
          textFields.push(queryField[field]);
        }
      });
    }

    // Add search on 'text' anyway:
    if (textFields.indexOf('displayText') === -1) {
      textFields.push('displayText');
    }

    if (searchVisa === true && textFields.indexOf('visa') === -1) {
      textFields.push('visa');
    }

    // Handle 'exact' match:
    if (query.operator && query.operator === 'exact') {
      textFields = textFields.map((item) => {
        if (item !== 'visa') {
          return item + '.exact';
        }
        return item;
      });
    }

    // Highlight text fields:
    textFields.forEach((field) => {
      searchQuery.body.highlight.fields[field] = {
        number_of_fragments: 0,
      };
    });

    // Finalize search in text fields:
    if (searchString.length > 0) {
      hasString = true;
      let operator = taxons[taxonFilter].operator.default.toUpperCase();
      let fuzzy = true;
      let finalSearchString = searchString.join(' ');
      if (query.operator) {
        if (query.operator === 'exact') {
          operator = 'AND';
          fuzzy = false;
          if (/^"/.test(string) === false || /"$/.test(string) === false) {
            finalSearchString = `"${string}"`.replace(/"+/gm, '"');
          }
        } else {
          operator = query.operator.toUpperCase();
        }
      }
      if (/[*()~|+-]/.test(string) && !relaxed) {
        operator = 'AND';
        fuzzy = false;
        finalSearchString = string;
      }
      searchQuery.body.query.function_score.query.bool.must = {
        simple_query_string: {
          query: finalSearchString,
          fields: textFields,
          default_operator: operator,
          auto_generate_synonyms_phrase_query: fuzzy,
          fuzzy_max_expansions: fuzzy ? 50 : 0,
          fuzzy_transpositions: fuzzy,
        },
      };
    }
  } else {
    throw new Error(`${process.env.APP_ID}.Elastic.buildQuery: unknown target "${target}".`);
  }

  return {
    page: page,
    page_size: page_size,
    queryField: queryField,
    textFields: textFields,
    query: searchQuery,
    hasString: hasString,
  };
}

module.exports = buildQuery;

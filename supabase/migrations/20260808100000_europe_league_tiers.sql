-- Re-tier the league catalog for the builder's quick-pick buttons:
--   tier 'top' = the TOP division of every European country (was only the big five)
--   tier 'mid' = those countries' SECOND divisions (Championship, Segunda, Serie B, ...)
-- 'uefa' rows are untouched. The builder sorts its league list by tier, and the 🏆 Top Europe /
-- 🥈 Mid tier buttons select these sets (strongest countries first when a plan cap bites).
update leagues set tier = 'top' where id in (
  39,   -- England · Premier League
  140,  -- Spain · La Liga
  135,  -- Italy · Serie A
  78,   -- Germany · Bundesliga
  61,   -- France · Ligue 1
  88,   -- Netherlands · Eredivisie
  94,   -- Portugal · Primeira Liga
  144,  -- Belgium · Jupiler Pro League
  179,  -- Scotland · Premiership
  203,  -- Turkey · Süper Lig
  218,  -- Austria · Bundesliga
  207,  -- Switzerland · Super League
  197,  -- Greece · Super League 1
  119,  -- Denmark · Superliga
  103,  -- Norway · Eliteserien
  113,  -- Sweden · Allsvenskan
  106,  -- Poland · Ekstraklasa
  210,  -- Croatia · HNL
  345,  -- Czech-Republic · Czech Liga
  333,  -- Ukraine · Premier League
  235,  -- Russia · Premier League
  283,  -- Romania · Liga I
  286,  -- Serbia · Super Liga
  271,  -- Hungary · NB I
  244,  -- Finland · Veikkausliiga
  164,  -- Iceland · Úrvalsdeild
  357,  -- Ireland · Premier Division
  110,  -- Wales · Premier League
  408,  -- Northern-Ireland · Premiership
  332,  -- Slovakia · Super Liga
  373,  -- Slovenia · 1. SNL
  172,  -- Bulgaria · First League
  383,  -- Israel · Ligat Ha'al
  318,  -- Cyprus · 1. Division
  310,  -- Albania · Superliga
  315,  -- Bosnia · Premijer Liga
  355,  -- Montenegro · First League
  664,  -- Kosovo · Superliga
  329,  -- Estonia · Meistriliiga
  365,  -- Latvia · Virsliga
  362,  -- Lithuania · A Lyga
  116,  -- Belarus · Premier League
  394,  -- Moldova · Super Liga
  327,  -- Georgia · Erovnuli Liga
  342,  -- Armenia · Premier League
  419,  -- Azerbaijan · Premyer Liqa
  389,  -- Kazakhstan · Premier League
  261,  -- Luxembourg · National Division
  393,  -- Malta · Premier League
  367,  -- Faroe-Islands · Meistaradeildin
  758   -- Gibraltar · Premier Division
);
update leagues set tier = 'mid' where id in (
  40,   -- England · Championship
  141,  -- Spain · Segunda División
  136,  -- Italy · Serie B
  79,   -- Germany · 2. Bundesliga
  62,   -- France · Ligue 2
  89,   -- Netherlands · Eerste Divisie
  95,   -- Portugal · Segunda Liga
  145,  -- Belgium · Challenger Pro League
  180,  -- Scotland · Championship
  204,  -- Turkey · 1. Lig
  219,  -- Austria · 2. Liga
  208,  -- Switzerland · Challenge League
  494,  -- Greece · Super League 2
  120,  -- Denmark · 1. Division
  104,  -- Norway · 1. Division
  114,  -- Sweden · Superettan
  107,  -- Poland · I Liga
  211,  -- Croatia · First NL
  346,  -- Czech-Republic · FNL
  334,  -- Ukraine · Persha Liga
  236,  -- Russia · First League
  284,  -- Romania · Liga II
  287,  -- Serbia · Prva Liga
  272,  -- Hungary · NB II
  165,  -- Iceland · 1. Deild
  358,  -- Ireland · First Division
  382,  -- Israel · Liga Leumit
  173   -- Bulgaria · Second League
);

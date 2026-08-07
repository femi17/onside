-- Quick-pick sets for the builder, continuing 20260808100000_europe_league_tiers:
--   tier 'sa_top' = South American top flights (🌎 S. America button)
--   tier 'as_top' = Asian/AFC top flights (🌏 Asia button)
-- Pages sort league lists by tier, so these slot between Europe's tiers and the untiered rest.
update leagues set tier = 'sa_top' where id in (
  71,   -- Brazil · Serie A
  128,  -- Argentina · Liga Profesional
  239,  -- Colombia · Primera A
  265,  -- Chile · Primera División
  268,  -- Uruguay · Primera División - Apertura
  270,  -- Uruguay · Primera División - Clausura
  242,  -- Ecuador · Liga Pro
  281,  -- Peru · Primera División
  250,  -- Paraguay · División Profesional - Apertura
  252,  -- Paraguay · División Profesional - Clausura
  344,  -- Bolivia · Primera División
  299   -- Venezuela · Primera División
);
update leagues set tier = 'as_top' where id in (
  98,   -- Japan · J1 League
  292,  -- South Korea · K League 1
  307,  -- Saudi-Arabia · Pro League
  169,  -- China · Super League
  305,  -- Qatar · Stars League
  301,  -- UAE · Pro League
  290,  -- Iran · Persian Gulf Pro League
  188,  -- Australia · A-League
  369,  -- Uzbekistan · Super League
  296,  -- Thailand · Thai League 1
  323,  -- India · Indian Super League
  340,  -- Vietnam · V.League 1
  274,  -- Indonesia · Liga 1
  278,  -- Malaysia · Super League
  542,  -- Iraq · Iraqi League
  417,  -- Bahrain · Premier League
  330,  -- Kuwait · Premier League
  387,  -- Jordan · League
  406   -- Oman · Professional League
);

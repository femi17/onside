-- Substitute to score (yes/no): any player who came on as a sub scores; own goals don't
-- count. Graded by poll from FRESH provider events (subs are never in the stored timeline);
-- a finished game whose feed recorded no substitutions stays pending for manual settle.
insert into markets (key, label, kind, tracks, description)
values ('sub_to_score', 'Substitute to score', 'player', null,
        'Any substitute (either team) to score. Own goals do not count.')
on conflict (key) do nothing;

-- item_map seed — generated from mp-qb-mapping.json (same_unit:true only)
-- 127 rows, one QuickB2B code per Maropost SKU. Ready to run as-is.
-- 85 unambiguous, 30 resolved by exact code match, 12 resolved by confirmed choice ([chosen]).
insert into item_map (maropost_sku, qb2b_item_code) values
  ('100', '100'),  -- Apple Fuji 1kg
  ('101', '101'),  -- [default] Apple Granny Smith 1kg
  ('103', '103'),  -- [default] Apple Royal Gala 1kg
  ('111', 'SWEE'),  -- [chosen] Sweet Potato Orange EACH
  ('114', 'ORAK'),  -- [chosen] Oranges NAVEL PER KILO
  ('137', 'MANK'),  -- [chosen] Mandarins PER KILO
  ('143', 'BROCK'),  -- [chosen] Broccoli PER KILO
  ('170', 'COSE'),  -- Lettuce Cos EACH
  ('178', 'ENG'),  -- Spinach English BUNCH
  ('216', 'MINI'),  -- Tomato Mini Roma PUNNET
  ('221', 'CHI'),  -- Chive BUNCH
  ('223', 'FEN'),  -- [chosen] Fennel BULB
  ('252', 'CAR1'),  -- Carrot 1KG BAG
  ('266', 'COSP'),  -- Lettuce Baby Cos PACKET
  ('268', 'ROCE'),  -- Rockmelon EACH
  ('506', 'PINK'),  -- [chosen] Apple Pink Lady 1kg
  ('550', 'CABH'),  -- Cabbage Cut HALF
  ('584', 'LEMG'),  -- Lemon Grass EACH
  ('5896', 'ORA3'),  -- Orange NAVEL Net 3kg
  ('650', 'PUMQ'),  -- [chosen] Pumpkin Grey PER KILO
  ('677', 'ORA3'),  -- Orange NAVEL Net 3kg
  ('712', 'BIT'),  -- [chosen] Bittermelon PER KILO
  ('ALF', 'ALF'),  -- Sprouts Alfalfa 125g PUNNET
  ('APPJ', 'APPJ'),  -- Apple Juicing 14kg
  ('ASP', 'ASP'),  -- Asparagus BUNCH
  ('AVOB', 'AVOB'),  -- Avocado Bulk CASE
  ('avoe', 'AVOE'),  -- Avocado EACH
  ('avoes', 'AVOES'),  -- Avocado Small Hard EACH
  ('bank', 'BANK'),  -- [default] Banana PER KILO
  ('bas', 'BAS'),  -- Basil BUNCH
  ('BEA', 'BEA'),  -- Bean PER KILO
  ('BEET', 'BEET'),  -- [default] Beetroot PER KILO
  ('BLUE', 'BLUE'),  -- Blueberry PUNNET
  ('bok', 'BOK'),  -- Bok Choy BUNCH
  ('BROCI', 'BROCI'),  -- Broccolini BUNCH
  ('BROCK', 'BROCK'),  -- [default] Broccoli PER KILO
  ('Cab', 'CAB'),  -- Cabbage Whole Green EACH
  ('CAPGK', 'CAPGK'),  -- [default] Capsicum Green PER KILO
  ('CAPMK', 'CAPMK'),  -- [default] Capsicum Mixed Coloured PER KILO
  ('CAPRK', 'CAPRK'),  -- [default] Capsicum Red PER KILO
  ('CAPYE', 'CAPYE'),  -- [default] Capsicum Yellow EACH
  ('CARD', 'CARD'),  -- Carrots Dutch BUNCH
  ('CARK', 'CARK'),  -- [default] Carrot Large PER KILO
  ('caue', 'CAUE'),  -- Cauliflower EACH
  ('CELB', 'CELB'),  -- Celery BUNCH
  ('CELE', 'CELERIAC'),  -- Celeriac EACH
  ('chert', 'CHERT'),  -- Tomato Cherry PUNNET
  ('CHERTH', 'CHERTM'),  -- [chosen] Tomato Medley PUNNET
  ('CHIBR', 'CHIBR'),  -- Chinese Broccoli BUNCH
  ('chil', 'CHIL'),  -- [default] Chilli Red PER KILO
  ('CHOY', 'CHOY'),  -- Choy Sum BUNCH
  ('COCC', 'COCC'),  -- Coconut Young CASE of 9
  ('COR', 'COR'),  -- Coriander Fresh BUNCH
  ('COSE', 'COSE'),  -- Lettuce Cos EACH
  ('COSP', 'COSP'),  -- Lettuce Baby Cos PACKET
  ('DAT', 'DAT'),  -- [default] Date PER KILO
  ('DILL', 'DILL'),  -- Dill BUNCH
  ('eggk', 'EGGK'),  -- [default] Eggplant PER KILO
  ('eggl', 'EGGL'),  -- [default] Eggplant Lebanese PER KILO
  ('ESH', 'ESH'),  -- Eshallot BUNCH
  ('frek', 'FREK'),  -- [default] French Onion PER KILO
  ('GARB', 'GARB'),  -- Garlic 500g BAG
  ('GARP', 'GARP'),  -- Garlic Peeled PER KILO
  ('GRAFR', 'GRAPFRE'),  -- Grapefruit Red EACH
  ('GRAFY', 'GRAF'),  -- [chosen] Grapefruit Yellow PER KILO
  ('GRAPK', 'GRAPK'),  -- Grapes Red Seedless PER KILO
  ('GRAPKG', 'GRAPKG'),  -- Grapes White Seedless PER KILO
  ('HON', 'HON'),  -- Honeydew Melon EACH
  ('HONC', 'HONC'),  -- Honeydew CASE
  ('JAPP', 'JAP'),  -- [chosen] Pumpkin Jap PER KILO
  ('kal', 'KAL'),  -- Kale BUNCH
  ('KIP', 'KIP'),  -- Potato Kipfler PER KILO
  ('KIWI', 'KIW'),  -- Kiwifruit Green EACH
  ('LEBC', 'LEBC'),  -- Cucumber Lebanese 10kg CASE
  ('LEBK', 'LEBK'),  -- [default] Cucumber Lebanese PER KILO
  ('LEE', 'LEE'),  -- Leek EACH
  ('lemk', 'LEMK'),  -- [default] Lemon PER KILO
  ('letc', 'LETC'),  -- Lettuce Iceberg CASE of 12
  ('lete', 'LETE'),  -- Lettuce Iceberg EACH
  ('MIN', 'MIN'),  -- Mint Fresh BUNCH
  ('MORN', 'KAN'),  -- Kang Kong BUNCH
  ('musk', 'MUSK'),  -- Mushroom Button PER KILO
  ('ONW', 'ONW'),  -- [default] Onion White PER KILO
  ('ORAJ', 'ORAJ'),  -- [default] Orange Juicing 14kg CASE
  ('oys', 'OYS'),  -- Mushroom Oyster 100g PACK
  ('PAR', 'PAR'),  -- Parsley Curly BUNCH
  ('PARF', 'PARF'),  -- Parsley Italian Flat Leaf BUNCH
  ('PARK', 'PARSNE'),  -- [chosen] Parsnip EACH
  ('parsn', 'PARSN'),  -- [default] Parsnip PER KILO
  ('pass', 'PASS'),  -- Passionfruit EACH
  ('PEAC', 'PEAC'),  -- Pear CASE
  ('PEAK', 'PEAK'),  -- [default] Pear PER KILO
  ('PINE', 'PINE'),  -- Pineapple Gold EACH
  ('POM', 'POM'),  -- Pomegranate EACH
  ('POT2', 'POT2'),  -- Potato Washed 2.5kg
  ('POT5', 'POT5'),  -- Potato Washed 5kg
  ('POT5B', 'POT5B'),  -- Potato Brushed 5kg BAG
  ('POTB', 'POTB'),  -- Potato Large 20/15kg BAG
  ('POTC', 'POTC'),  -- [default] Potato Chat Small Gourmet PER KILO
  ('POTD', 'POTD'),  -- [default] Potato Desiree PER KILO
  ('POTDB', 'POTDB'),  -- Potato Desiree 20kg BAG
  ('POTP', 'POTPD'),  -- Potato Peeled Desiree 10kg BAG
  ('POTPD', 'POTPD'),  -- Potato Peeled Desiree 10kg BAG
  ('POTPDA', 'POTPD'),  -- Potato Peeled Desiree 10kg BAG
  ('PUMB', 'PUMB'),  -- [default] Pumpkin Butternut PER KILO
  ('PUMP', 'PUMP'),  -- Pumpkin Peeled PER KILO
  ('RAD', 'RAD'),  -- Radish BAG
  ('ras', 'RAS'),  -- Raspberry PUNNET
  ('rhu', 'RHU'),  -- Rhubarb BUNCH
  ('ROCE', 'ROCE'),  -- Rockmelon EACH
  ('ros', 'ROS'),  -- Rosemary BUNCH
  ('sag', 'SAG'),  -- Sage BUNCH
  ('shi', 'SHI'),  -- Mushroom Shiitake 100g PACK
  ('snake', 'SNAKE'),  -- Bean Snake 250g BUNCH
  ('SNOWP', 'SNOWP'),  -- Snow Pea PER KILO
  ('STRAW', 'STR'),  -- Strawberry PUNNET
  ('SWE', 'SWE'),  -- [default] Swede PER KILO
  ('swec', 'SWEC'),  -- Sweet Potato CASE
  ('swek', 'SWEK'),  -- [default] Sweet Potato Orange PER KILO
  ('TEL', 'TEL'),  -- Cucumber Telegraph EACH
  ('THY', 'THY'),  -- Thyme BUNCH
  ('TOMK', 'TOMK'),  -- [default] Tomato Gourmet PER KILO
  ('TOMRK', 'TOMRK'),  -- [default] Tomato Roma PER KILO
  ('TOMTK', 'TOMTK'),  -- Tomato Truss PER KILO
  ('TUR', 'TUR'),  -- [default] Turnip PER KILO
  ('WOM', 'WOM'),  -- Wom Bok EACH
  ('ZUCK', 'ZUCK')  -- [default] Zucchini PER KILO
on conflict (maropost_sku) do update set qb2b_item_code = excluded.qb2b_item_code;

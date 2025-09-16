-- Create tables in correct dependency order for PostgreSQL

-- Create the user table first since it's referenced by other tables
CREATE TABLE "user" (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50),
    password VARCHAR(255),
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    email VARCHAR(100),
    phone VARCHAR(20),
    user_image VARCHAR(200),
    active BOOLEAN DEFAULT TRUE,
    created_datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    email_verified BOOLEAN DEFAULT FALSE,
    zip_code VARCHAR(10),
    birth_month INTEGER,
    birth_day INTEGER,
    birth_year INTEGER,
    gender VARCHAR(10),
    receive_sms BOOLEAN DEFAULT FALSE,
    receive_email BOOLEAN DEFAULT TRUE,
    prayer_frequency INTEGER DEFAULT 1,
    family_circle BOOLEAN DEFAULT FALSE,
    family_circle_image VARCHAR(200),
    family_circle_name VARCHAR(100),
    family_circle_description TEXT,
    family_circle_prayers INTEGER DEFAULT 0
);

-- Create category table
CREATE TABLE category (
    category_id SERIAL PRIMARY KEY,
    category_name VARCHAR(50) NOT NULL,
    active BOOLEAN DEFAULT TRUE
);

-- Create blog_article table
CREATE TABLE blog_article (
    id SERIAL PRIMARY KEY,
    created_datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    title VARCHAR(100),
    blog_article_file VARCHAR(20),
    preview VARCHAR(500),
    image VARCHAR(100)
);

-- Create blessings table
CREATE TABLE blessings (
    blessings_id SERIAL PRIMARY KEY,
    blessings_text VARCHAR(200) NOT NULL,
    "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    blessings_color VARCHAR(40),
    fk_user_id INTEGER,
    CONSTRAINT fk_user_id_constraint FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE SET NULL
);

-- Create family table
CREATE TABLE family (
    id SERIAL PRIMARY KEY,
    family_member_name VARCHAR(100),
    phone VARCHAR(20),
    email VARCHAR(100),
    relationship VARCHAR(50),
    fk_user_id INTEGER,
    CONSTRAINT family_user_fk FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE CASCADE
);

-- Create meal table  
CREATE TABLE meal (
    meal_id SERIAL PRIMARY KEY,
    meal_name VARCHAR(200) NOT NULL,
    "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    meal_color VARCHAR(40),
    fk_user_id INTEGER,
    CONSTRAINT meal_user_fk FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE SET NULL
);

-- Create request table
CREATE TABLE request (
    request_id SERIAL PRIMARY KEY,
    request_text TEXT NOT NULL,
    fk_user_id INTEGER,
    fk_category_id INTEGER,
    "timestamp" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    active BOOLEAN DEFAULT TRUE,
    anonymous BOOLEAN DEFAULT FALSE,
    request_image VARCHAR(200),
    total_prayers INTEGER DEFAULT 0,
    "views" INTEGER DEFAULT 0,
    CONSTRAINT request_user_fk FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE CASCADE,
    CONSTRAINT request_category_fk FOREIGN KEY (fk_category_id) REFERENCES category (category_id) ON DELETE SET NULL
);

-- Create prayers table
CREATE TABLE prayers (
    prayer_id SERIAL PRIMARY KEY,
    prayer_text TEXT,
    "timestamp" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fk_user_id INTEGER,
    fk_request_id INTEGER,
    CONSTRAINT prayers_user_fk FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE CASCADE,
    CONSTRAINT prayers_request_fk FOREIGN KEY (fk_request_id) REFERENCES request (request_id) ON DELETE CASCADE
);

-- Create comments table
CREATE TABLE comments (
    comments_id SERIAL PRIMARY KEY,
    user_id INTEGER,
    request_id INTEGER,
    comment VARCHAR(400),
    "timestamp" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT comments_user_fk FOREIGN KEY (user_id) REFERENCES "user" (user_id) ON DELETE CASCADE,
    CONSTRAINT comments_request_fk FOREIGN KEY (request_id) REFERENCES request (request_id) ON DELETE CASCADE
);

-- Create rosary table
CREATE TABLE rosary (
    rosary_id SERIAL PRIMARY KEY,
    rosary_text VARCHAR(200) NOT NULL,
    "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rosary_color VARCHAR(40),
    fk_user_id INTEGER,
    CONSTRAINT rosary_user_fk FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE SET NULL
);

-- Create settings table
CREATE TABLE settings (
    id SERIAL PRIMARY KEY,
    setting_name VARCHAR(100),
    setting_value TEXT,
    created_datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create sponge table
CREATE TABLE sponge (
    sponge_id SERIAL PRIMARY KEY,
    sponge_text VARCHAR(200) NOT NULL,
    "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sponge_color VARCHAR(40),
    fk_user_id INTEGER,
    CONSTRAINT sponge_user_fk FOREIGN KEY (fk_user_id) REFERENCES "user" (user_id) ON DELETE SET NULL
);

-- Create user_family table
CREATE TABLE user_family (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    family_id INTEGER,
    CONSTRAINT user_family_user_fk FOREIGN KEY (user_id) REFERENCES "user" (user_id) ON DELETE CASCADE,
    CONSTRAINT user_family_family_fk FOREIGN KEY (family_id) REFERENCES family (id) ON DELETE CASCADE
);

-- Create user_request table
CREATE TABLE user_request (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    request_id INTEGER,
    CONSTRAINT user_request_user_fk FOREIGN KEY (user_id) REFERENCES "user" (user_id) ON DELETE CASCADE,
    CONSTRAINT user_request_request_fk FOREIGN KEY (request_id) REFERENCES request (request_id) ON DELETE CASCADE
);

-- Create visitors table
CREATE TABLE visitors (
    id SERIAL PRIMARY KEY,
    ip_address VARCHAR(45),
    visit_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_agent TEXT,
    page_visited VARCHAR(200)
);
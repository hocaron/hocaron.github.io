---
layout: post
title:  "[Troubleshooting - DB] Index and Deadlock"
comments: true
tags: Troubleshooting
excerpt_separator: <!--more-->
lang: en
permalink: /dead-lock-by-index/
---

### Have I Defeated It?

Pepe starts crying again... (Stop crying!)

Let's record this as a meaningful experience.

![Pepe crying](https://velog.velcdn.com/images/haron/post/1687c152-873d-425f-96f9-174735a9c262/image.png)

## Reproducing the Deadlock Scenario

### Current Table State
```sql
CREATE TABLE parent
(
    id             bigint        not null primary key,
    name           varchar(255)  null,
    updated_at     datetime(6)   null
);

CREATE TABLE child
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT parent_id_unique UNIQUE (parent_id)
);

CREATE TABLE child_index
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null
);
CREATE INDEX parent_id ON child_index (parent_id);

INSERT INTO parent VALUES (1, 'parent_1', NOW());
```
1. Created the `child_index` table with `parent_id` as an index (foreign key removed for testing).
2. Created the `child` table with `parent_id` as a unique key (foreign key removed for testing).
3. Inserted test data into the `parent` table.

### Let's Cause a Deadlock

Performing row delete on `child_index` followed by row insert on `child_index` in two sessions causes a deadlock 💣

![Deadlock scenario](https://velog.velcdn.com/images/haron/post/bc47166e-b1b7-4f30-ac1f-09932cb38ff7/image.png)

| TX1 | TX2 | Lock |
|-----|-----|------|
| BEGIN ;<br> DELETE FROM child_index WHERE parent_id = 2; | | (1) Child X Lock, but TX2 can acquire X Lock 🤔 |
| | BEGIN ;<br> DELETE FROM child_index WHERE parent_id = 2; | (2) Child X Lock |
| INSERT INTO child_index VALUES ('1', 'name2', 2); | | (3) Waiting for Child X, INSERT_INTENTION Lock |
| | INSERT INTO child_index VALUES ('2', 'name2', 2); | (4) Waiting for Child X, INSERT_INTENTION Lock |
| | Deadlock found when trying to get lock; try restarting transaction | (4) Needs Child X lock, but (2) holds Child X lock <br> To resolve (4), (3) must resolve <br> To resolve (3), TX2 must commit <br> To commit TX2, (4) must resolve <br> -> Deadlock occurs |

## Examining the Deadlock Logic in Production

Performing row delete on `child_index` followed by row insert on `child_index` in two sessions causes a deadlock 💣

```sql
SELECT * FROM parent WHERE id = 1;
INSERT INTO child VALUES (1, 'child_1', 1);
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
UPDATE parent SET updated_at = NOW() WHERE id = 1;
```

```java
@Transactional
public void createChildAndChildIndex(long parentId) {
    var parent = parentRepository.findById(parentId);

    childIndexRepository.deleteByParent(parent);
    childIndexRepository.save(new Child_Index('child_index_1', parent));
}
```
- Interestingly, a deadlock occurs when the data to be deleted does not exist.
- When the data to be deleted exists, the lock waits until it can be acquired.

## Solutions to Resolve the Deadlock in Production

### ❎ First Attempt: Delete Row Only If It Exists
```java
@Transactional
public void createParent(long parentId) {
    var parent = parentRepository.findById(parentId);

    if (childIndexRepository.findByParent(parent).isPresent()) {
        childIndexRepository.deleteByParent(parent);
    }
    childIndexRepository.save(new Child_Index('child_index_1', parent));
}
```
- This prevents the exclusive lock due to the unconditional delete logic.
- If concurrent requests find no data in `childIndexRepository.findByParent`, data may be duplicated.
  - Testing with a 300ms thread sleep confirmed duplication.

### ✅ Second Attempt: Delete Row Only If It Exists with Unique Constraint
```sql
CREATE TABLE child_index
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT parent_id_unique UNIQUE (parent_id)
);
CREATE INDEX parent_id ON child_index (parent_id);
```
- Concurrent requests with no data found in `childIndexRepository.findByParent` result in a duplicate key error for subsequent commits.

### ❎ Third Attempt: Add Key for Concurrency Control in Redis
- Due to occasional deadlocks and the absence of Redis usage in this service, the cache resource overhead seemed excessive.

### ❎ Fourth Attempt: Limit Requests
- Using Bucket4j to limit the number of API calls a client can make within a specific time frame.
- Deadlock prevention is impossible with multiple servers as concurrent requests can hit different servers.

## Summary
1. When data is not present, delete queries allow delete and select but wait for the lock during insert.
2. For more on locks, refer to the [InnoDB Locking Documentation in MySQL Official Manual](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html#innodb-record-locks). It is well-organized with examples.

### Interesting Experiment
#### Query Based on Indexed Column
- When data exists, the second transaction waits for the lock during delete.
```sql
BEGIN ;
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
COMMIT ;
```
- When data does not exist, the second transaction acquires the lock immediately during delete.
```sql
BEGIN ;
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
COMMIT ;
```
#### Query Based on Non-Indexed Column
- Whether data exists or not, the second transaction waits for the lock during delete.
```sql
BEGIN ;
DELETE FROM child_index WHERE name = 'child_index_2';
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
COMMIT ;
```

### For the Record
<details>
<summary>SHOW ENGINE innodb STATUS;</summary>
  *** (1) TRANSACTION:TRANSACTION 13034, ACTIVE 6 sec insertingmysql tables in use 1, locked 1LOCK WAIT 4 lock struct(s), heap size 1128, 3 row lock(s), undo log entries 1MySQL thread id 280, OS thread handle 6136639488, query id 21716 localhost 127.0.0.1 root update/* ApplicationName=DataGrip 2022.3.2 */ insert into child values ('2', 'name2', 2)

*** (1) HOLDS THE LOCK(S):RECORD LOCKS space id 154 page no 4 n bits 72 index PRIMARY of table jpa.child trx id 13034 lock_mode X locks rec but not gapRecord lock, heap no 3 PHYSICAL RECORD: n_fields 5; compact format; info bits 0

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:RECORD LOCKS space id 154 page no 5 n bits 72 index parent_id of table jpa.child trx id 13034 lock_mode X insert intention waitingRecord lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0

*** (2) TRANSACTION:TRANSACTION 13035, ACTIVE 4 sec insertingmysql tables in use 1, locked 1LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s)MySQL thread id 281, OS thread handle 6135525376, query id 21726 localhost 127.0.0.1 root update/* ApplicationName=DataGrip 2022.3.2 */ insert into child values ('2', 'name2', 2)

*** (2) HOLDS THE LOCK(S):RECORD LOCKS space id 154 page no 5 n bits 72 index parent_id of table jpa.child trx id 13035 lock_mode XRecord lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:RECORD LOCKS space id 154 page no 4 n bits 72 index PRIMARY of table jpa.child trx id 13035 lock mode S locks rec but not gap waitingRecord lock, heap no 3 PHYSICAL RECORD: n_fields 5; compact format; info bits 0

- SELECT * FROM performance_schema.data_locks;

| INDEX\_NAME | OBJECT\_INSTANCE\_BEGIN | LOCK\_TYPE | LOCK\_MODE | LOCK\_STATUS | LOCK\_DATA |
| :--- | :--- | :--- | :--- | :--- | :--- |
| null | 4813003272 | TABLE | IX | GRANTED | null |
| parent\_id | 4823656472 | RECORD | X | GRANTED | supremum pseudo-record |
| parent\_id | 4823656816 | RECORD | X,INSERT\_INTENTION | GRANTED | supremum pseudo-record |
| parent\_id | 4823657160 | RECORD | X,GAP | GRANTED | 1, 1 |
</details>
